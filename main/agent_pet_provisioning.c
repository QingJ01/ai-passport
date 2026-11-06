#include "agent_pet_provisioning.h"
#include "agent_pet_runtime.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"
#include "mbedtls/pk.h"
#include "mbedtls/ecp.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha256.h"
#include "nvs.h"
#include "cJSON.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/* One owner performs crypto, NVS and manager lifecycle. BLE callbacks only
 * answer bounded reads or enqueue one request; no credentials reach logs. */
#define REQUEST_MAX 4096
#define RESPONSE_MAX 2048
static SemaphoreHandle_t guard;
static TaskHandle_t worker;
static bool active, confirmed, start_requested, stop_requested, manager_live;
static bool work_pending, work_done, credential_received, credential_success, network_prepared;
static bool enrolled[2], finish_requested;
static int selected_slot;
static uint64_t deadline, quiesce_started;
static char qr[1024], name[32], pop[33], nonce[65], device_id[65], public_pem[256];
static char service_roots[2][512], prepared_ssid[33];
static char request[REQUEST_MAX+1], response[RESPONSE_MAX+1], request_id[33];
static wifi_sta_config_t network;
static mbedtls_pk_context identity;
static nvs_handle_t identity_store;
static const char service_uuid[] = "0000ffff-0000-1000-8000-00805f9b34fb";
/* ESP-IDF takes the 128-bit advertising UUID in least-significant-byte order. */
static uint8_t ble_service_uuid[16]={
    0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,
    0x00,0x10,0x00,0x00,0xff,0xff,0x00,0x00
};
static uint64_t milliseconds(void) { return (uint64_t)esp_timer_get_time()/1000; }
static int rng(void *ctx, unsigned char *out, size_t size) { (void)ctx; esp_fill_random(out,size); return 0; }
static void hex_random(char *out, size_t bytes) {
    static const char digits[]="0123456789abcdef";
    for(size_t i=0;i<bytes;i++){unsigned x=esp_random()&255;out[2*i]=digits[x>>4];out[2*i+1]=digits[x&15];}
    out[2*bytes]=0;
}
static const char *string(cJSON *object,const char *key,size_t cap) {
    cJSON *value=cJSON_GetObjectItemCaseSensitive(object,key);
    if(!cJSON_IsString(value)||strlen(value->valuestring)>=cap)return NULL;
    return value->valuestring;
}
static bool p256(mbedtls_pk_context *key) {
    return mbedtls_pk_can_do(key,MBEDTLS_PK_ECDSA) &&
        mbedtls_ecp_keypair_get_group_id(mbedtls_pk_ec(*key))==MBEDTLS_ECP_DP_SECP256R1;
}
static esp_err_t load_identity(void) {
    esp_err_t result=nvs_open("pet_identity",NVS_READWRITE,&identity_store);
    if(result!=ESP_OK)return result;
    mbedtls_pk_init(&identity);
    unsigned char pem[512]={0};size_t n=sizeof(pem);
    result=nvs_get_blob(identity_store,"private",pem,&n);
    if(result==ESP_ERR_NVS_NOT_FOUND){
        if(mbedtls_pk_setup(&identity,mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) ||
           mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1,mbedtls_pk_ec(identity),rng,NULL) ||
           mbedtls_pk_write_key_pem(&identity,pem,sizeof(pem)))return ESP_FAIL;
        result=nvs_set_blob(identity_store,"private",pem,strlen((char*)pem)+1);
        if(result==ESP_OK)result=nvs_commit(identity_store);
    }else if(result==ESP_OK){
        if(n<1||pem[n-1]||mbedtls_pk_parse_key(&identity,pem,n,NULL,0,rng,NULL))result=ESP_FAIL;
    }
    memset(pem,0,sizeof(pem));
    if(result!=ESP_OK||!p256(&identity))return ESP_FAIL;
    if(mbedtls_pk_write_pubkey_pem(&identity,(unsigned char*)public_pem,sizeof(public_pem)))return ESP_FAIL;
    unsigned char hash[32];mbedtls_sha256((unsigned char*)public_pem,strlen(public_pem),hash,0);
    for(size_t i=0;i<16;i++)snprintf(device_id+2*i,3,"%02x",hash[i]);
    const char *root_names[2]={"service_root","remote_root"};
    for(size_t profile=0;profile<2;profile++) {
        n=sizeof(service_roots[profile]);
        result=nvs_get_str(identity_store,root_names[profile],service_roots[profile],&n);
        if(result!=ESP_OK&&result!=ESP_ERR_NVS_NOT_FOUND)return result;
    }
    return ESP_OK;
}
static char *base64url(const unsigned char *data,size_t length) {
    unsigned char temp[160];size_t n=0;
    if(mbedtls_base64_encode(temp,sizeof(temp)-1,&n,data,length))return NULL;
    while(n&&temp[n-1]=='=')n--;
    temp[n]=0;for(size_t i=0;i<n;i++){if(temp[i]=='+')temp[i]='-';if(temp[i]=='/')temp[i]='_';}
    return strdup((char*)temp);
}
static bool decode_signature(const char *text,unsigned char *out,size_t *length) {
    char temp[160];size_t n=strlen(text);if(n>140)return false;
    for(size_t i=0;i<n;i++){
        char c=text[i];
        if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='-'||c=='_'))return false;
        temp[i]=c=='-'?'+':c=='_'?'/':c;
    }
    while(n%4) {
        temp[n++]='=';
    }
    temp[n]=0;
    return mbedtls_base64_decode(out,80,length,(unsigned char*)temp,n)==0;
}
static cJSON *error_result(const char *text) {
    cJSON *result=cJSON_CreateObject();if(result)cJSON_AddStringToObject(result,"error",text);return result;
}
static cJSON *configuration_error(const char *message) {
    pet_runtime_cancel_setup();
    return error_result(message);
}
static cJSON *execute(cJSON *input) {
    const char *op=string(input,"op",32);
    if(!op)return error_result("invalid_operation");
    cJSON *transport=cJSON_GetObjectItemCaseSensitive(input,"transport");
    pet_transport_t target=PET_TRANSPORT_LOCAL;
    if(transport) {
        if(!cJSON_IsString(transport))return error_result("invalid_transport");
        if(!strcmp(transport->valuestring,"remote"))target=PET_TRANSPORT_REMOTE;
        else if(strcmp(transport->valuestring,"local"))return error_result("invalid_transport");
    }
    char *trusted_root=service_roots[(size_t)target];
    if(!strcmp(op,"service.trust")){
        const char *pem=string(input,"public_key_pem",sizeof(service_roots[0]));
        if(!pem)return error_result("invalid_key");
        if(trusted_root[0]&&strcmp(pem,trusted_root))return error_result("ownership_reset_required");
        mbedtls_pk_context key;mbedtls_pk_init(&key);
        bool valid=mbedtls_pk_parse_public_key(&key,(unsigned char*)pem,strlen(pem)+1)==0&&p256(&key);
        mbedtls_pk_free(&key);if(!valid)return error_result("invalid_key");
        const char *root_name=target==PET_TRANSPORT_REMOTE?"remote_root":"service_root";
        if(nvs_set_str(identity_store,root_name,pem)!=ESP_OK||nvs_commit(identity_store)!=ESP_OK)return error_result("storage_error");
        snprintf(trusted_root,sizeof(service_roots[0]),"%s",pem);
        cJSON *result=cJSON_CreateObject();if(result)cJSON_AddBoolToObject(result,"trusted",true);return result;
    }
    if(!strcmp(op,"enroll")){
        if(!trusted_root[0])return error_result("service_not_trusted");
        cJSON *ticket_object=cJSON_GetObjectItemCaseSensitive(input,"ticket");
        const char *canonical=string(ticket_object,"canonical",2500),*signature=string(ticket_object,"signature",160);
        if(!canonical||!signature)return error_result("invalid_ticket");
        unsigned char bytes[80],hash[32];size_t n=0;
        if(!decode_signature(signature,bytes,&n))return error_result("invalid_signature");
        mbedtls_pk_context key;mbedtls_pk_init(&key);
        mbedtls_sha256((unsigned char*)canonical,strlen(canonical),hash,0);
        bool valid=mbedtls_pk_parse_public_key(&key,(unsigned char*)trusted_root,strlen(trusted_root)+1)==0&&p256(&key)&&mbedtls_pk_verify(&key,MBEDTLS_MD_SHA256,hash,32,bytes,n)==0;
        mbedtls_pk_free(&key);if(!valid)return error_result("invalid_signature");
        cJSON *payload=cJSON_Parse(canonical);if(!payload)return error_result("invalid_ticket");
        const char *domain=string(payload,"domain",64),*id=string(payload,"device_id",65),*challenge=string(payload,"nonce",65),*pem=string(payload,"public_key_pem",256),*ticket=string(payload,"ticket",160);
        cJSON *expiry=cJSON_GetObjectItemCaseSensitive(payload,"expires_at");
        valid=domain&&!strcmp(domain,"agentpet-enroll-v1")&&id&&!strcmp(id,device_id)&&challenge&&!strcmp(challenge,nonce)&&pem&&!strcmp(pem,public_pem)&&ticket&&ticket[0]&&cJSON_IsNumber(expiry);
        time_t now=time(NULL);if(now>=1735689600&&cJSON_IsNumber(expiry)&&expiry->valuedouble<(double)now*1000)valid=false;
        if(!valid){cJSON_Delete(payload);return error_result("ticket_binding_failed");}
        mbedtls_sha256((unsigned char*)ticket,strlen(ticket),hash,0);
        n=0;int sign_result=mbedtls_pk_sign(&identity,MBEDTLS_MD_SHA256,hash,32,bytes,sizeof(bytes),&n,rng,NULL);
        cJSON_Delete(payload);if(sign_result)return error_result("signing_failed");
        char *proof=base64url(bytes,n);if(!proof)return error_result("signing_failed");
        cJSON *result=cJSON_CreateObject();if(result){cJSON_AddBoolToObject(result,"service_signature_verified",true);cJSON_AddStringToObject(result,"device_id",device_id);cJSON_AddStringToObject(result,"nonce",nonce);cJSON_AddStringToObject(result,"proof",proof);enrolled[(size_t)target]=true;}
        free(proof);return result;
    }
    if(!strcmp(op,"service.configure")){
        if(!enrolled[(size_t)target])return configuration_error("enrollment_required");
        const char *endpoint=string(input,"endpoint",257),*token=string(input,"credential",129),*ca=string(input,"ca_pem",2049),*server=string(input,"server_name",129);
        cJSON *t=cJSON_GetObjectItemCaseSensitive(input,"time");
        if(!endpoint||!token||!cJSON_IsNumber(t)||t->valuedouble<1735689600||t->valuedouble>4102444800)return configuration_error("invalid_configuration");
        const char *bootstrap=string(input,"time_bootstrap_url",257),*issuer=string(input,"time_issuer",65),*root=string(input,"enrollment_public_key_pem",512);
        if(root&&strcmp(root,trusted_root))return configuration_error("service_key_mismatch");
        if((bootstrap&&!issuer)||(!bootstrap&&issuer))return configuration_error("incomplete_time_configuration");
        if(!pet_runtime_setup_target(target))return configuration_error("configuration_busy");
        if(!pet_runtime_device_identity(device_id)||
           !pet_runtime_time_bootstrap(bootstrap?bootstrap:"",issuer?issuer:"",trusted_root))return configuration_error("invalid_configuration");
        bool queued=pet_runtime_mobile_config(endpoint,token,ca?ca:"",server?server:"",(uint32_t)t->valuedouble);
        if(!queued)pet_runtime_cancel_setup();
        cJSON *result=cJSON_CreateObject();if(result){cJSON_AddBoolToObject(result,"accepted",queued);cJSON_AddStringToObject(result,"state",queued?"validating_path":"rejected");}return result;
    }
    return error_result("unsupported");
}
static bool shallow_json(const uint8_t *data,size_t n) {
    unsigned depth=0;bool in_string=false,escape=false;
    for(size_t i=0;i<n;i++){
        unsigned char c=data[i];if(!c)return false;
        if(in_string){if(escape)escape=false;else if(c=='\\')escape=true;else if(c=='"')in_string=false;}
        else if(c=='"')in_string=true;
        else if(c=='{'||c=='['){if(++depth>8)return false;}
        else if(c=='}'||c==']'){if(!depth)return false;depth--;}
    }
    return !depth&&!in_string;
}
static esp_err_t endpoint(uint32_t session_id,const uint8_t *data,ssize_t length,uint8_t **out,ssize_t *out_length,void *ctx) {
    (void)session_id;(void)ctx;
    if(length<=0||length>REQUEST_MAX||!shallow_json(data,(size_t)length))return ESP_ERR_INVALID_ARG;
    cJSON *input=cJSON_ParseWithLength((char*)data,(size_t)length);if(!input)return ESP_ERR_INVALID_ARG;
    const char *op=string(input,"op",32);cJSON *result=NULL;
    char saved_networks[3][33]={{0}};
    size_t network_count=op&&!strcmp(op,"challenge")?pet_runtime_network_slots(saved_networks):0;
    xSemaphoreTake(guard,portMAX_DELAY);
    if(!active||milliseconds()>=deadline)result=error_result("expired");
    else if(op&&!strcmp(op,"challenge")){
        const char *challenge=string(input,"nonce",65);
        if(!challenge||strcmp(challenge,nonce))result=error_result("wrong_nonce");
        else{result=cJSON_CreateObject();if(result){cJSON_AddStringToObject(result,"device_id",device_id);cJSON_AddStringToObject(result,"nonce",nonce);cJSON_AddStringToObject(result,"public_key_pem",public_pem);cJSON_AddBoolToObject(result,"physical_confirmed",confirmed);cJSON *slots=cJSON_AddArrayToObject(result,"network_slots");if(slots)for(size_t i=0;i<network_count&&i<3;i++)cJSON_AddItemToArray(slots,cJSON_CreateString(saved_networks[i]));cJSON_AddNumberToObject(result,"max_network_slots",3);cJSON *caps=cJSON_AddArrayToObject(result,"capabilities");if(caps){cJSON_AddItemToArray(caps,cJSON_CreateString("network-candidate-v1"));cJSON_AddItemToArray(caps,cJSON_CreateString("network-retry-v1"));cJSON_AddItemToArray(caps,cJSON_CreateString("enrollment-v1"));cJSON_AddItemToArray(caps,cJSON_CreateString("transport-profiles-v1"));}}}
    }else if(op&&!strcmp(op,"result")){
        const char *id=string(input,"request_id",33);
        if(!id||strcmp(id,request_id))result=error_result("unknown_request");
        else{result=cJSON_CreateObject();if(result){cJSON_AddBoolToObject(result,"pending",!work_done);if(work_done)cJSON_AddItemToObject(result,"result",cJSON_Parse(response));}}
    }else if(!confirmed)result=error_result("confirm_on_device");
    else if(op&&!strcmp(op,"finish")){
        if(work_pending)result=error_result("busy");
        else{finish_requested=true;deadline=milliseconds()+500;result=cJSON_CreateObject();if(result)cJSON_AddBoolToObject(result,"finished",true);}
    }else if(op&&!strcmp(op,"network.prepare")){
        const char *ssid=string(input,"ssid",33);cJSON *slot=cJSON_GetObjectItemCaseSensitive(input,"replace_slot");
        bool valid_slot=!slot||(cJSON_IsNumber(slot)&&(slot->valuedouble==0||slot->valuedouble==1||slot->valuedouble==2));
        if(!ssid||!ssid[0]||!valid_slot)result=error_result("invalid_network_slot");
        else{snprintf(prepared_ssid,sizeof(prepared_ssid),"%s",ssid);selected_slot=slot?slot->valueint:-1;network_prepared=true;result=cJSON_CreateObject();if(result)cJSON_AddBoolToObject(result,"ready",true);}
    }else if(op&&(!strcmp(op,"service.trust")||!strcmp(op,"enroll")||!strcmp(op,"service.configure"))){
        if(work_pending)result=error_result("busy");
        else{memcpy(request,data,(size_t)length);request[length]=0;hex_random(request_id,16);work_done=false;work_pending=true;response[0]=0;result=cJSON_CreateObject();if(result){cJSON_AddBoolToObject(result,"pending",true);cJSON_AddStringToObject(result,"request_id",request_id);}}
    }else result=error_result("unsupported");
    xSemaphoreGive(guard);cJSON_Delete(input);
    if(!result)return ESP_ERR_NO_MEM;
    char *encoded=cJSON_PrintUnformatted(result);cJSON_Delete(result);if(!encoded)return ESP_ERR_NO_MEM;
    *out=(uint8_t*)encoded;*out_length=(ssize_t)strlen(encoded);return ESP_OK;
}
static void prov_event(void *arg,esp_event_base_t base,int32_t id,void *data) {
    (void)arg;(void)base;xSemaphoreTake(guard,portMAX_DELAY);
    if(id==WIFI_PROV_CRED_RECV&&data){memcpy(&network,data,sizeof(network));credential_received=true;}
    if(id==WIFI_PROV_CRED_SUCCESS)credential_success=true;
    bool retry=id==WIFI_PROV_CRED_FAIL;
    /* A wrong password or a missing network must not end the window: forget the
     * rejected credential and let the phone send corrected ones in this session. */
    if(retry){credential_received=false;credential_success=false;memset(&network,0,sizeof(network));}
    xSemaphoreGive(guard);
    if(retry)wifi_prov_mgr_reset_sm_state_on_failure();
}
static void stop_manager(void) {
    if(manager_live){wifi_prov_mgr_stop_provisioning();wifi_prov_mgr_deinit();esp_event_handler_unregister(WIFI_PROV_EVENT,ESP_EVENT_ANY_ID,prov_event);manager_live=false;}
    xSemaphoreTake(guard,portMAX_DELAY);active=false;confirmed=false;stop_requested=false;finish_requested=false;memset(enrolled,0,sizeof(enrolled));work_pending=false;work_done=false;credential_received=false;credential_success=false;network_prepared=false;memset(&network,0,sizeof(network));memset(qr,0,sizeof(qr));memset(pop,0,sizeof(pop));memset(request,0,sizeof(request));memset(response,0,sizeof(response));quiesce_started=0;xSemaphoreGive(guard);
    /* Re-enable business traffic only after SDK BLE teardown has finished. */
    pet_runtime_pause_business(false);
}
static bool start_manager(void) {
    wifi_prov_mgr_config_t cfg={.scheme=wifi_prov_scheme_ble,.scheme_event_handler=WIFI_PROV_EVENT_HANDLER_NONE,.app_event_handler=WIFI_PROV_EVENT_HANDLER_NONE,.wifi_prov_conn_cfg={.wifi_conn_attempts=3}};
    if(wifi_prov_scheme_ble_set_service_uuid(ble_service_uuid)!=ESP_OK)return false;
    if(wifi_prov_mgr_init(cfg)!=ESP_OK) {
        return false;
    }
    manager_live=true;
    if(esp_event_handler_register(WIFI_PROV_EVENT,ESP_EVENT_ANY_ID,prov_event,NULL)!=ESP_OK)return false;
    if(wifi_prov_mgr_disable_auto_stop(1000)!=ESP_OK||wifi_prov_mgr_endpoint_create("agentpet-setup")!=ESP_OK)return false;
    return wifi_prov_mgr_start_provisioning(WIFI_PROV_SECURITY_1,pop,name,NULL)==ESP_OK&&wifi_prov_mgr_endpoint_register("agentpet-setup",endpoint,NULL)==ESP_OK;
}
static bool prepare_window(void) {
    hex_random(pop,16);hex_random(nonce,32);snprintf(name,sizeof(name),"PROV_%.12s",device_id);
    cJSON *q=cJSON_CreateObject();if(!q)return false;
    cJSON_AddStringToObject(q,"ver","agentpet-v1");cJSON_AddStringToObject(q,"name",name);cJSON_AddStringToObject(q,"transport","ble");cJSON_AddNumberToObject(q,"security",1);cJSON_AddStringToObject(q,"pop",pop);cJSON_AddStringToObject(q,"device_id",device_id);cJSON_AddStringToObject(q,"public_key_pem",public_pem);cJSON_AddStringToObject(q,"nonce",nonce);cJSON_AddStringToObject(q,"service_uuid",service_uuid);
    char *text=cJSON_PrintUnformatted(q);cJSON_Delete(q);if(!text)return false;
    xSemaphoreTake(guard,portMAX_DELAY);bool fits=strlen(text)<sizeof(qr);if(fits){snprintf(qr,sizeof(qr),"%s",text);active=true;confirmed=false;deadline=milliseconds()+120000;}xSemaphoreGive(guard);free(text);return fits;
}
static void run(void *arg) {
    (void)arg;
    xSemaphoreTake(guard,portMAX_DELAY);
    bool identity_ready=load_identity()==ESP_OK;
    xSemaphoreGive(guard);
    for(;;){
        char saved_ssid[33]={0}, saved_key[65]={0};
        xSemaphoreTake(guard,portMAX_DELAY);bool start=start_requested;start_requested=false;bool expired=active&&milliseconds()>=deadline;bool cancel=stop_requested||(expired&&!finish_requested);bool stop=stop_requested||expired;bool work=work_pending&&!work_done;bool save_network=active&&confirmed&&credential_received&&credential_success&&network_prepared;
        if(save_network){memcpy(saved_ssid,network.ssid,32);memcpy(saved_key,network.password,64);}
        bool allowed=save_network&&!strcmp(saved_ssid,prepared_ssid);xSemaphoreGive(guard);
        if(cancel)pet_runtime_cancel_setup();
        if(stop)stop_manager();
        if(start){
            pet_runtime_cancel_setup();
            stop_manager();
            pet_runtime_pause_business(true);
            if(!identity_ready||!prepare_window()){
                stop_manager();
                ESP_LOGW("pet_provision","identity_or_window_unavailable");
                pet_runtime_provision_failed();
            }
        }
        xSemaphoreTake(guard,portMAX_DELAY);bool enable=active&&confirmed&&!manager_live&&!stop_requested;xSemaphoreGive(guard);
        if(enable){
            if(pet_runtime_business_stopped()){
                quiesce_started=0;
                if(!start_manager()){
                    stop_manager();
                    ESP_LOGW("pet_provision","ble_start_unavailable");
                    pet_runtime_provision_failed();
                }
            }else{
                if(!quiesce_started)quiesce_started=milliseconds();
                if(milliseconds()-quiesce_started>=5000){
                    stop_manager();
                    ESP_LOGW("pet_provision","business_stop_timeout");
                    pet_runtime_provision_failed();
                }
            }
        }
        if(work&&!stop&&!start){cJSON *input=cJSON_Parse(request);cJSON *result=input?execute(input):error_result("invalid_request");cJSON_Delete(input);char *text=result?cJSON_PrintUnformatted(result):NULL;cJSON_Delete(result);xSemaphoreTake(guard,portMAX_DELAY);snprintf(response,sizeof(response),"%s",text&&strlen(text)<sizeof(response)?text:"{\"error\":\"response_too_large\"}");work_done=true;work_pending=false;memset(request,0,sizeof(request));xSemaphoreGive(guard);free(text);}
        if(save_network&&!stop&&!start){if(allowed)pet_runtime_network_candidate(saved_ssid,saved_key,selected_slot);xSemaphoreTake(guard,portMAX_DELAY);credential_success=false;credential_received=false;memset(&network,0,sizeof(network));xSemaphoreGive(guard);}
        memset(saved_key,0,sizeof(saved_key));
        vTaskDelay(pdMS_TO_TICKS(25));
    }
}
esp_err_t pet_provision_start(void) {
    if(!guard){guard=xSemaphoreCreateMutex();if(!guard){pet_runtime_provision_failed();return ESP_ERR_NO_MEM;}}
    if(!worker&&xTaskCreate(run,"pet_ble_setup",10240,NULL,3,&worker)!=pdPASS){pet_runtime_provision_failed();return ESP_ERR_NO_MEM;}
    xSemaphoreTake(guard,portMAX_DELAY);start_requested=true;xSemaphoreGive(guard);return ESP_OK;
}
void pet_provision_confirm(void){if(!guard)return;xSemaphoreTake(guard,portMAX_DELAY);if(active)confirmed=true;xSemaphoreGive(guard);}
void pet_provision_stop(void){if(!guard)return;xSemaphoreTake(guard,portMAX_DELAY);stop_requested=true;xSemaphoreGive(guard);}
bool pet_provision_active(void){if(!guard)return false;xSemaphoreTake(guard,portMAX_DELAY);bool value=active||start_requested;xSemaphoreGive(guard);return value;}
bool pet_provision_qr(char *destination,size_t capacity){if(!guard||!destination||!capacity)return false;xSemaphoreTake(guard,portMAX_DELAY);bool valid=active&&qr[0]&&strlen(qr)<capacity;if(valid)snprintf(destination,capacity,"%s",qr);else destination[0]=0;xSemaphoreGive(guard);return valid;}

/* Called only for a physically confirmed profile-unpair action, before reboot.
 * Preserve the persistent P-256 identity, other service root and Wi-Fi slots. */
esp_err_t pet_provision_forget_service(bool remote) {
    SemaphoreHandle_t held_guard=guard;
    if(held_guard)xSemaphoreTake(held_guard,portMAX_DELAY);
    esp_err_t result=ESP_ERR_INVALID_STATE;
    if(!active&&!start_requested&&!manager_live&&!work_pending){
        nvs_handle_t store;
        result=nvs_open("pet_identity",NVS_READWRITE,&store);
        if(result==ESP_OK){
            result=nvs_erase_key(store,remote?"remote_root":"service_root");
            if(result==ESP_ERR_NVS_NOT_FOUND)result=ESP_OK;
            if(result==ESP_OK)result=nvs_commit(store);
            nvs_close(store);
        }
        if(result==ESP_OK){
            memset(service_roots[remote?1:0],0,sizeof(service_roots[0]));
            enrolled[remote?1:0]=false;
        }
    }
    if(held_guard)xSemaphoreGive(held_guard);
    return result;
}
