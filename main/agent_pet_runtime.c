#include "agent_pet_runtime.h"
#include "agent_pet_provisioning.h"
#include "agent_pet_time.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "esp_websocket_client.h"
#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#define EV_WAKE 1u
#define EV_WIFI_UP 2u
#define EV_WIFI_DOWN 4u
#define EV_WS_UP 8u
#define EV_WS_DOWN 16u
#define EV_DATA 32u
/* Saved configuration is immutable throughout a trial. A single candidate is
 * shared by USB/BLE; no previous/full-connection copies consume resident RAM. */
static pet_config_t config;
static pet_candidate_t candidate;
static pet_model_t model;
static pet_action_t host_action;
static char device_boot_id[65];
static bool action_command_pending,serial_policy_pending,serial_resync_pending;
static pet_action_command_t action_command;
static SemaphoreHandle_t lock;
static TaskHandle_t worker;
static nvs_handle_t store;
static bool storage_ready,network_ready,wifi_up,trial,trial_snapshot;
static bool candidate_initialized,candidate_queued,pending,confirmed;
static bool reconnect,privacy_save,rx_ready,rx_bad,fragmented,serial_discard;
static bool authenticated,pause_requested,pause_acknowledged,cancel_requested,cancel_processing;
static volatile bool pending_wifi_up;
static uint32_t trial_started,auth_started,last_received,setup_until;
static char status_text[64]="USB setup required";
static char firmware_sha[65];
static char rx[PET_FRAME_MAX+1],serial_line[PET_FRAME_MAX+1];
static size_t rx_len,serial_len;
static int frame_offset;
static esp_websocket_client_handle_t client;
static const pet_transport_config_t *connection;
static pet_transport_t connection_mode;
static pet_settings_action_t settings_action;
static uint32_t ui_keys_seen;
static unsigned ui_page;
static bool ui_menu,ui_details;
static volatile uint32_t allocation_failures;

/* Driver TX serializes one complete JSON line with the VFS log writer. */
static int serial_write_packet(const char *bytes,int length,TickType_t timeout){
    if(!bytes||length<=0||length>PET_FRAME_MAX+1)return -1;
    flockfile(stdout);
    int written=usb_serial_jtag_write_bytes(bytes,(size_t)length,timeout);
    funlockfile(stdout);
    return written;
}
static uint32_t millis(void){return (uint32_t)(esp_timer_get_time()/1000);}
static void notify(uint32_t bits){if(worker)xTaskNotify(worker,bits,eSetBits);}
static void epoch(char *out){snprintf(out,65,"%08lx%08lx%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random(),(unsigned long)esp_random(),(unsigned long)esp_random());}
static bool window_open(void){return setup_until!=0&&(int32_t)(setup_until-millis())>0;}
static void status(const char*s){xSemaphoreTake(lock,portMAX_DELAY);snprintf(status_text,sizeof(status_text),"%s",s);xSemaphoreGive(lock);}
static pet_task_t *action_target(void){for(unsigned i=0;i<model.current.task_count;i++)if(!strcmp(model.current.tasks[i].id,host_action.target_id))return &model.current.tasks[i];return NULL;}
static bool action_channel(void){return config.mode==PET_TRANSPORT_LOCAL&&!model.public_mode&&!trial&&!pause_requested&&!cancel_requested&&!cancel_processing&&model.current.valid&&!model.synchronizing&&(window_open()||(authenticated&&connection_mode==PET_TRANSPORT_LOCAL));}
static bool action_target_fresh(const pet_task_t*t){return t&&t->can_open_host&&model.current.source_connected&&model.current.source_fresh;}
static void revalidate_action(void){
    pet_action_tick(&host_action,millis());
    if(host_action.phase==PET_ACTION_PREPARING||host_action.phase==PET_ACTION_READY){pet_task_t*t=action_target();if(!t||!t->can_open_host||t->state_revision!=host_action.target_revision){host_action.phase=PET_ACTION_CONFLICT;memset(host_action.token,0,sizeof(host_action.token));}}
}
bool pet_runtime_open_prepare(const char *id){
    if(!lock||!id||!id[0]||strlen(id)>PET_ID_MAX)return false;
    xSemaphoreTake(lock,portMAX_DELAY);pet_model_tick(&model,millis());pet_task_t*t=NULL;
    for(unsigned i=0;i<model.current.task_count;i++)if(!strcmp(model.current.tasks[i].id,id)){t=&model.current.tasks[i];break;}
    bool ok=action_channel()&&action_target_fresh(t)&&!action_command_pending;
    if(ok){char action_id[65];epoch(action_id);ok=pet_action_begin(&host_action,id,t->state_revision,action_id,millis());if(ok){action_command=PET_ACTION_PREPARE_COMMAND;action_command_pending=true;}}
    if(!ok)snprintf(status_text,sizeof(status_text),"Host action unavailable; check request");
    xSemaphoreGive(lock);notify(EV_WAKE);return ok;
}
bool pet_runtime_open_confirm(void){
    if(!lock)return false;
    xSemaphoreTake(lock,portMAX_DELAY);revalidate_action();pet_task_t*t=action_target();
    bool ok=action_channel()&&action_target_fresh(t)&&!action_command_pending&&pet_action_confirm(&host_action,t->state_revision,millis());
    if(ok){action_command=PET_ACTION_EXECUTE_COMMAND;action_command_pending=true;}
    else if(host_action.phase==PET_ACTION_READY){host_action.phase=PET_ACTION_CONFLICT;memset(host_action.token,0,sizeof(host_action.token));}
    xSemaphoreGive(lock);notify(EV_WAKE);return ok;
}
void pet_runtime_open_cancel(void){
    if(!lock)return;
    xSemaphoreTake(lock,portMAX_DELAY);
    if(host_action.phase==PET_ACTION_PREPARING||host_action.phase==PET_ACTION_READY){pet_action_hide_private(&host_action);action_command_pending=false;}
    xSemaphoreGive(lock);
}
bool pet_runtime_open_query(void){
    if(!lock)return false;
    xSemaphoreTake(lock,portMAX_DELAY);pet_action_tick(&host_action,millis());bool pending=host_action.phase==PET_ACTION_SENT||host_action.phase==PET_ACTION_ACCEPTED||host_action.phase==PET_ACTION_UNKNOWN;
    bool ok=action_channel()&&pending&&!action_command_pending;
    if(ok){action_command=PET_ACTION_QUERY_COMMAND;action_command_pending=true;}
    xSemaphoreGive(lock);notify(EV_WAKE);return ok;
}
void pet_runtime_open_copy(pet_action_view_t*out){
    memset(out,0,sizeof(*out));if(!lock)return;
    xSemaphoreTake(lock,portMAX_DELAY);revalidate_action();out->phase=host_action.phase;
    if(!model.public_mode){snprintf(out->target_id,sizeof(out->target_id),"%s",host_action.target_id);pet_task_t*t=action_target();if(t)snprintf(out->title,sizeof(out->title),"%s",t->title);out->can_confirm=host_action.phase==PET_ACTION_READY&&action_channel()&&action_target_fresh(t);out->can_query=action_channel()&&(host_action.phase==PET_ACTION_SENT||host_action.phase==PET_ACTION_ACCEPTED||host_action.phase==PET_ACTION_UNKNOWN);}
    xSemaphoreGive(lock);
}
static void failed_allocation(size_t size,uint32_t caps,const char *function){(void)size;(void)caps;(void)function;if(allocation_failures<UINT32_MAX)allocation_failures++;}
void pet_runtime_phase(const char *phase){
    ESP_LOGI("pet_mem","%s heap_free=%u min_heap=%u largest_block=%u allocation_failures=%u stack_min_free=%u",
             phase,(unsigned)esp_get_free_heap_size(),(unsigned)esp_get_minimum_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),(unsigned)allocation_failures,
             worker?(unsigned)uxTaskGetStackHighWaterMark(worker):0u);
}
static void clear_candidate(void){memset(&candidate,0,sizeof(candidate));candidate.replace_slot=-1;candidate_initialized=false;candidate_queued=false;pending=false;confirmed=false;}
static void fresh_view(void){char e[65];epoch(e);bool pub=model.public_mode;pet_model_privacy(&model,pub,e);pet_action_hide_private(&host_action);action_command_pending=false;serial_policy_pending=window_open();model.needs_resync=false;rx_ready=false;rx_len=0;fragmented=false;memset(rx,0,sizeof(rx));}
static bool profile_present(pet_transport_t mode){return config.transport[mode].endpoint[0]!=0;}
static void init_candidate(pet_transport_t target){
    if(!candidate_initialized){memset(&candidate,0,sizeof(candidate));candidate.replace_slot=-1;candidate_initialized=true;}
    candidate.target=target;candidate.profile=config.transport[target];candidate.has_profile=profile_present(target);
}
void pet_runtime_provision_failed(void){if(lock)status("Phone setup unavailable; try USB");}
void pet_runtime_pause_business(bool pause){if(!lock)return;xSemaphoreTake(lock,portMAX_DELAY);pause_requested=pause;pause_acknowledged=false;xSemaphoreGive(lock);notify(EV_WAKE);}
bool pet_runtime_business_stopped(void){if(!lock)return false;xSemaphoreTake(lock,portMAX_DELAY);bool stopped=pause_requested&&pause_acknowledged;xSemaphoreGive(lock);return stopped;}
void pet_runtime_ui_state(uint32_t count,unsigned page,bool menu,bool details){if(!lock)return;xSemaphoreTake(lock,portMAX_DELAY);ui_keys_seen=count;ui_page=page<4?page:0;ui_menu=menu;ui_details=details;xSemaphoreGive(lock);}
void pet_runtime_copy(pet_runtime_view_t*out,char*s,size_t cap){
    if(!lock){memset(out,0,sizeof(*out));snprintf(s,cap,"Runtime unavailable");return;}
    xSemaphoreTake(lock,portMAX_DELAY);pet_model_tick(&model,millis());out->current=model.current;out->public_mode=model.public_mode;out->transport=(pet_transport_t)config.mode;snprintf(s,cap,"%s",status_text);xSemaphoreGive(lock);
}
void pet_runtime_privacy(bool pub){if(!lock)return;xSemaphoreTake(lock,portMAX_DELAY);char e[65];epoch(e);pet_model_privacy(&model,pub,e);pet_action_hide_private(&host_action);action_command_pending=false;serial_policy_pending=window_open();rx_ready=false;rx_len=0;fragmented=false;memset(rx,0,sizeof(rx));memset(serial_line,0,sizeof(serial_line));serial_len=0;serial_discard=true;privacy_save=true;reconnect=true;xSemaphoreGive(lock);notify(EV_WAKE);}
void pet_runtime_setup_window(void){if(!lock)return;xSemaphoreTake(lock,portMAX_DELAY);if(!trial){clear_candidate();setup_until=millis()+120000;fresh_view();reconnect=true;snprintf(status_text,sizeof(status_text),"USB setup: 120 seconds");}xSemaphoreGive(lock);notify(EV_WAKE);}
void pet_runtime_confirm(void){if(!lock)return;xSemaphoreTake(lock,portMAX_DELAY);if(pending&&window_open())confirmed=true;xSemaphoreGive(lock);notify(EV_WAKE);}
bool pet_runtime_setup_pending(void){if(!lock)return false;xSemaphoreTake(lock,portMAX_DELAY);bool yes=pending&&window_open();xSemaphoreGive(lock);return yes;}
void pet_runtime_cancel_setup(void){if(!lock)return;xSemaphoreTake(lock,portMAX_DELAY);cancel_requested=true;xSemaphoreGive(lock);notify(EV_WAKE);}
void pet_runtime_settings_action(pet_settings_action_t action){if(!lock||action<1||action>4)return;xSemaphoreTake(lock,portMAX_DELAY);settings_action=action;xSemaphoreGive(lock);notify(EV_WAKE);}
size_t pet_runtime_network_slots(char ssids[PET_NETWORK_MAX][33]){if(!lock||!ssids)return 0;xSemaphoreTake(lock,portMAX_DELAY);size_t count=config.network_count;for(unsigned i=0;i<PET_NETWORK_MAX;i++)snprintf(ssids[i],33,"%s",i<count?config.networks[i].ssid:"");xSemaphoreGive(lock);return count;}
bool pet_runtime_network_slot(char *ssid,size_t cap){if(!lock||!ssid||cap<33)return false;xSemaphoreTake(lock,portMAX_DELAY);bool present=config.network_count>0;snprintf(ssid,cap,"%s",present?config.networks[config.active_network].ssid:"");xSemaphoreGive(lock);return present;}
bool pet_runtime_setup_target(pet_transport_t target){
    if(!lock||(unsigned)target>PET_TRANSPORT_REMOTE)return false;
    xSemaphoreTake(lock,portMAX_DELAY);bool ok=!trial&&!pending&&!cancel_requested&&!cancel_processing;
    if(ok)init_candidate(target); /* Does not discard the already staged network. */
    xSemaphoreGive(lock);return ok;
}
bool pet_runtime_select_transport(pet_transport_t target){
    if(!lock||(unsigned)target>PET_TRANSPORT_REMOTE)return false;
    xSemaphoreTake(lock,portMAX_DELAY);bool ok=!trial&&!pending&&!cancel_requested&&!cancel_processing&&profile_present(target)&&config.network_count;
    if(ok){clear_candidate();init_candidate(target);candidate_queued=true;setup_until=0;fresh_view();reconnect=true;}else snprintf(status_text,sizeof(status_text),"Configure selected service first");
    xSemaphoreGive(lock);notify(EV_WAKE);return ok;
}
bool pet_runtime_network_candidate(const char *ssid,const char *key,int slot){
    if(!lock||!ssid||!ssid[0]||strlen(ssid)>32||!key||strlen(key)>64||slot < -1||slot>=PET_NETWORK_MAX)return false;
    xSemaphoreTake(lock,portMAX_DELAY);bool ok=!trial&&!pending&&!cancel_requested&&!cancel_processing;
    if(ok){if(!candidate_initialized)init_candidate((pet_transport_t)config.mode);snprintf(candidate.network.ssid,33,"%s",ssid);snprintf(candidate.network.key,65,"%s",key);candidate.has_network=true;candidate.replace_slot=slot;ok=pet_config_network_slot(&config,&candidate)>=0;candidate_queued=ok;}
    xSemaphoreGive(lock);notify(EV_WAKE);return ok;
}
static bool clean_identifier(const char*s,size_t cap){if(!s||!s[0]||strlen(s)>=cap)return false;for(;*s;s++)if((unsigned char)*s<33||(unsigned char)*s>126||*s=='"'||*s=='\\')return false;return true;}
bool pet_runtime_device_identity(const char *id){if(!lock||!clean_identifier(id,97))return false;xSemaphoreTake(lock,portMAX_DELAY);bool ok=!trial&&!pending&&!cancel_requested&&!cancel_processing;if(ok){if(!candidate_initialized)init_candidate(PET_TRANSPORT_LOCAL);snprintf(candidate.profile.device_id,97,"%s",id);}xSemaphoreGive(lock);return ok;}
bool pet_runtime_time_bootstrap(const char *url,const char *issuer,const char *pem){
    bool disabled=url&&issuer&&!url[0]&&!issuer[0];
    if(!lock||(!disabled&&(!url||strlen(url)>256||strncmp(url,"http://",7)||strpbrk(url,"@?#")||!clean_identifier(url,257)||!clean_identifier(issuer,65)||!pem||!pem[0]||strlen(pem)>512)))return false;
    xSemaphoreTake(lock,portMAX_DELAY);bool ok=!trial&&!pending&&!cancel_requested&&!cancel_processing;
    if(ok){if(!candidate_initialized)init_candidate(PET_TRANSPORT_LOCAL);snprintf(candidate.profile.time_url,257,"%s",disabled?"":url);snprintf(candidate.profile.time_issuer,65,"%s",disabled?"":issuer);snprintf(candidate.profile.time_key,513,"%s",disabled?"":pem);}
    xSemaphoreGive(lock);return ok;
}
bool pet_runtime_mobile_config(const char *endpoint,const char *token,const char *ca,const char *server,uint32_t utc){
    if(!lock||!clean_identifier(endpoint,257)||strncmp(endpoint,"wss://",6)||strpbrk(endpoint,"@?#")||!clean_identifier(token,129)||strlen(token)<43||!ca||strlen(ca)>2048||!server||strlen(server)>128||utc<1735689600u||utc>4102444800u)return false;
    xSemaphoreTake(lock,portMAX_DELAY);bool ok=!trial&&!pending&&!cancel_requested&&!cancel_processing;
    if(ok){if(!candidate_initialized)init_candidate(PET_TRANSPORT_LOCAL);snprintf(candidate.profile.endpoint,257,"%s",endpoint);snprintf(candidate.profile.token,129,"%s",token);snprintf(candidate.profile.ca,2049,"%s",ca);snprintf(candidate.profile.server,129,"%s",server);candidate.utc_seconds=utc;candidate.has_profile=pet_config_profile_valid(&candidate.profile);candidate_queued=candidate.has_profile;ok=candidate_queued;}
    xSemaphoreGive(lock);notify(EV_WAKE);return ok;
}
static void wifi_event(void*arg,esp_event_base_t base,int32_t id,void*data){(void)arg;(void)data;if(base==IP_EVENT&&id==IP_EVENT_STA_GOT_IP){pending_wifi_up=true;notify(EV_WIFI_UP);}else if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_DISCONNECTED){pending_wifi_up=false;notify(EV_WIFI_DOWN);}}
static void ws_event(void*arg,esp_event_base_t base,int32_t id,void*data){
    (void)arg;(void)base;esp_websocket_event_data_t*e=data;
    if(id==WEBSOCKET_EVENT_CONNECTED){notify(EV_WS_UP);return;}
    if(id==WEBSOCKET_EVENT_DISCONNECTED||id==WEBSOCKET_EVENT_CLOSED){notify(EV_WS_DOWN);return;}
    if(id!=WEBSOCKET_EVENT_DATA||(e->op_code!=1&&e->op_code!=0))return;
    xSemaphoreTake(lock,portMAX_DELAY);
    if(e->payload_offset==0){frame_offset=0;if(e->op_code==1){rx_bad=rx_ready||fragmented;rx_len=0;fragmented=true;}else if(!fragmented)rx_bad=true;if(e->payload_len<0||(size_t)e->payload_len>PET_FRAME_MAX-rx_len)rx_bad=true;}
    if(e->payload_offset!=frame_offset||e->data_len<0||e->payload_offset<0||e->data_len>e->payload_len-e->payload_offset)rx_bad=true;
    if(!rx_bad&&e->data_len>0){if(rx_len+(size_t)e->data_len>PET_FRAME_MAX)rx_bad=true;else{memcpy(rx+rx_len,e->data_ptr,e->data_len);rx_len+=e->data_len;}}
    frame_offset+=e->data_len;
    if(e->payload_offset+e->data_len==e->payload_len&&e->fin){if(!rx_bad){rx[rx_len]=0;rx_ready=true;}else model.needs_resync=true;fragmented=false;}
    xSemaphoreGive(lock);notify(EV_DATA);
}
static void stop_client(void){
    bool had_client=client!=NULL;
    xSemaphoreTake(lock,portMAX_DELAY);authenticated=false;auth_started=0;xSemaphoreGive(lock);
    if(client){esp_websocket_client_stop(client);esp_websocket_client_destroy(client);client=NULL;}
    connection=NULL;
    xSemaphoreTake(lock,portMAX_DELAY);rx_ready=false;rx_len=0;fragmented=false;rx_bad=false;frame_offset=0;memset(rx,0,sizeof(rx));
    if(had_client){if(host_action.phase==PET_ACTION_SENT||host_action.phase==PET_ACTION_ACCEPTED)host_action.phase=PET_ACTION_UNKNOWN;else if(host_action.phase==PET_ACTION_PREPARING||host_action.phase==PET_ACTION_READY)host_action.phase=PET_ACTION_EXPIRED;memset(host_action.token,0,sizeof(host_action.token));}
    xSemaphoreGive(lock);
}
static void handshake(void){
    char message[512],view_epoch[65];bool pub;
    xSemaphoreTake(lock,portMAX_DELAY);snprintf(view_epoch,65,"%s",model.view_epoch);pub=model.public_mode;xSemaphoreGive(lock);
    if(connection_mode==PET_TRANSPORT_LOCAL){int n=snprintf(message,sizeof(message),"{\"v\":1,\"type\":\"hello\",\"payload\":{\"device_id\":\"%s\",\"versions\":[1],\"view_epoch\":\"%s\",\"public_mode\":%s}}",connection->device_id,view_epoch,pub?"true":"false");esp_websocket_client_send_text(client,message,n,pdMS_TO_TICKS(1000));}
    int n=connection_mode==PET_TRANSPORT_REMOTE?snprintf(message,sizeof(message),"{\"v\":1,\"type\":\"auth\",\"payload\":{\"credential\":\"%s\",\"device_id\":\"%s\",\"view_epoch\":\"%s\",\"public_mode\":%s}}",connection->token,connection->device_id,view_epoch,pub?"true":"false"):snprintf(message,sizeof(message),"{\"v\":1,\"type\":\"auth\",\"payload\":{\"credential\":\"%s\"}}",connection->token);
    if(n<=0||(size_t)n>=sizeof(message)||esp_websocket_client_send_text(client,message,n,pdMS_TO_TICKS(1000))<0)notify(EV_WS_DOWN);
    memset(message,0,sizeof(message));auth_started=millis();
}
static void configure_local_view(void){
    char message[192];
    xSemaphoreTake(lock,portMAX_DELAY);int n=snprintf(message,sizeof(message),"{\"v\":1,\"type\":\"view.configure\",\"payload\":{\"mode\":\"%s\",\"view_epoch\":\"%s\"}}",model.public_mode?"public":"private",model.view_epoch);xSemaphoreGive(lock);
    if(esp_websocket_client_send_text(client,message,n,pdMS_TO_TICKS(1000))<0)notify(EV_WS_DOWN);
}
static bool connect_wifi(const pet_network_t *network){
    if(!network_ready||!network||!network->ssid[0])return false;
    wifi_config_t w={0};memcpy(w.sta.ssid,network->ssid,strlen(network->ssid));
    memcpy(w.sta.password,network->key,strlen(network->key));
    w.sta.threshold.authmode=network->key[0]?WIFI_AUTH_WPA2_PSK:WIFI_AUTH_OPEN;
    esp_wifi_disconnect();esp_err_t result=esp_wifi_set_config(WIFI_IF_STA,&w);memset(&w,0,sizeof(w));
    return result==ESP_OK&&esp_wifi_connect()==ESP_OK;
}
static bool serial_control(bool policy,char sent_epoch[65]){
    char message[256];
    xSemaphoreTake(lock,portMAX_DELAY);snprintf(sent_epoch,65,"%s",model.view_epoch);
    int n=policy?snprintf(message,sizeof(message),"{\"v\":1,\"type\":\"view.configure\",\"view_epoch\":\"%s\",\"payload\":{\"mode\":\"%s\",\"view_epoch\":\"%s\"}}",model.view_epoch,model.public_mode?"public":"private",model.view_epoch):snprintf(message,sizeof(message),"{\"v\":1,\"type\":\"resync\",\"view_epoch\":\"%s\",\"payload\":{}}",model.view_epoch);
    xSemaphoreGive(lock);
    if(n<=0||(size_t)n>=sizeof(message))return false;
    message[n++]='\n';return serial_write_packet(message,n,pdMS_TO_TICKS(100))==n;
}
static void dispatch_action(void){
    char message[800];bool usb=false;int length=-1;pet_action_command_t command;
    xSemaphoreTake(lock,portMAX_DELAY);
    if(!action_command_pending){xSemaphoreGive(lock);return;}
    command=action_command;action_command_pending=false;revalidate_action();
    if(action_channel()){
        pet_task_t*t=action_target();bool valid=command==PET_ACTION_QUERY_COMMAND||(action_target_fresh(t)&&t->state_revision==host_action.target_revision);
        if(valid)length=pet_action_compose(&host_action,command,model.view_epoch,message,sizeof(message));
        else if(command==PET_ACTION_EXECUTE_COMMAND){host_action.phase=PET_ACTION_CONFLICT;memset(host_action.token,0,sizeof(host_action.token));}
        usb=window_open();
    }
    xSemaphoreGive(lock);
    bool sent=false;
    if(length>0){
        if(usb){if((size_t)length<sizeof(message)){message[length++]='\n';sent=serial_write_packet(message,length,pdMS_TO_TICKS(100))==length;}}
        else if(client&&authenticated&&connection_mode==PET_TRANSPORT_LOCAL)sent=esp_websocket_client_send_text(client,message,length,pdMS_TO_TICKS(1000))==length;
    }
    memset(message,0,sizeof(message));
    xSemaphoreTake(lock,portMAX_DELAY);
    if(command==PET_ACTION_EXECUTE_COMMAND){memset(host_action.token,0,sizeof(host_action.token));if(!sent&&host_action.phase==PET_ACTION_SENT)host_action.phase=PET_ACTION_UNKNOWN;}
    else if(!sent&&command==PET_ACTION_PREPARE_COMMAND&&host_action.phase==PET_ACTION_PREPARING)host_action.phase=PET_ACTION_EXPIRED;
    xSemaphoreGive(lock);
}
static bool persist(const pet_config_t *value){if(!storage_ready||!pet_config_valid(value)||nvs_set_blob(store,"config2",value,sizeof(*value))!=ESP_OK)return false;esp_err_t e=nvs_erase_key(store,"config");return (e==ESP_OK||e==ESP_ERR_NVS_NOT_FOUND)&&nvs_commit(store)==ESP_OK;}
static void acknowledge(const char*result){char b[128];int n=snprintf(b,sizeof(b),"{\"v\":1,\"type\":\"setup.result\",\"payload\":{\"status\":\"%s\"}}\n",result);serial_write_packet(b,n,pdMS_TO_TICKS(20));}
static int serial_kind(const char*s,size_t n){pet_json_t j;uint32_t v;char type[32];if(!pet_json_parse(&j,s,n)||!pet_json_uint(&j,pet_json_field(&j,0,"v"),&v)||v!=1||!pet_json_string(&j,pet_json_field(&j,0,"type"),type,sizeof(type)))return -1;return !strcmp(type,"device.info")?0:!strcmp(type,"setup")?1:2;}
static void device_info(void){
    int32_t remaining=(int32_t)(setup_until-millis());unsigned seconds=setup_until&&remaining>0?((uint32_t)remaining+999)/1000:0;
    const pet_transport_config_t*p=&config.transport[config.mode];
    char response[1024];int n=snprintf(response,sizeof(response),"{\"v\":1,\"type\":\"device.info\",\"payload\":{\"device_id\":\"%s\",\"view_epoch\":\"%s\",\"public_mode\":%s,\"configured\":%s,\"fwversion\":\"agent-pet-0.2-dev\",\"elf_sha256\":\"%s\",\"applied_revision\":%lu,\"task_count\":%u,\"source_fresh\":%s,\"synchronizing\":%s,\"keys_seen\":%lu,\"page\":%u,\"menu\":%s,\"details\":%s,\"usb_window_s\":%u,\"transport\":\"%s\",\"network_count\":%u,\"heap_free\":%u,\"min_heap\":%u,\"largest_block\":%u,\"allocation_failures\":%u,\"stack_min_free\":%u}}\n",p->device_id[0]?p->device_id:"passport-1",model.view_epoch,model.public_mode?"true":"false",p->endpoint[0]&&config.network_count?"true":"false",firmware_sha,(unsigned long)model.current.revision,model.current.task_count,model.current.source_fresh?"true":"false",model.synchronizing?"true":"false",(unsigned long)ui_keys_seen,ui_page,ui_menu?"true":"false",ui_details?"true":"false",seconds,config.mode==PET_TRANSPORT_REMOTE?"remote":"local",config.network_count,(unsigned)esp_get_free_heap_size(),(unsigned)esp_get_minimum_free_heap_size(),(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),(unsigned)allocation_failures,(unsigned)uxTaskGetStackHighWaterMark(worker));
    if(n>0&&(size_t)n<sizeof(response))serial_write_packet(response,n,pdMS_TO_TICKS(30));
}
/* Caller holds runtime lock; replies are bounded and never logged. */
static void ingest_action_frame(const char *bytes,size_t length){
    if(config.mode!=PET_TRANSPORT_LOCAL||model.public_mode||trial||!model.current.valid)return;
    struct timeval wall={0};gettimeofday(&wall,NULL);uint64_t utc=wall.tv_sec>=1735689600?(uint64_t)wall.tv_sec*1000+(uint64_t)wall.tv_usec/1000:0;
    pet_action_ingest(&host_action,bytes,length,model.view_epoch,model.current.stream,millis(),utc);
    revalidate_action();
}
static void serial_process(bool provisioning){
    unsigned char bytes[256];size_t consumed=0;
    /* Bound each drain pass but consume a whole frame without 25 ms/128B stalls. */
    while(consumed<PET_FRAME_MAX){int n=usb_serial_jtag_read_bytes(bytes,sizeof(bytes),0);if(n<=0)break;consumed+=(size_t)n;
        xSemaphoreTake(lock,portMAX_DELAY);
        for(int i=0;i<n;i++){
            if(bytes[i]=='\n'){
                if(!serial_discard&&serial_len){serial_line[serial_len]=0;int kind=serial_kind(serial_line,serial_len);
                    if(kind==0)device_info();
                    else if(provisioning||pause_requested||trial||cancel_requested||cancel_processing)acknowledge("busy");
                    else if(!window_open())acknowledge("setup_window_required");
                    else if(kind==1){if(pet_config_parse_setup(serial_line,serial_len,&candidate)&&pet_config_network_slot(&config,&candidate)>=0){candidate_initialized=true;pending=true;confirmed=false;snprintf(status_text,sizeof(status_text),"Setup received: press OK");acknowledge("confirm_on_device");}else{clear_candidate();acknowledge("invalid_configuration_or_slot");}}
                    else if(kind==2){pet_result_t r=pet_model_ingest(&model,serial_line,serial_len,millis());if(r==PET_ACTION_CONTROL)ingest_action_frame(serial_line,serial_len);if(r==PET_REJECTED||r==PET_RESYNC)acknowledge("rejected");}
                    else acknowledge("rejected");
                }
                memset(serial_line,0,sizeof(serial_line));serial_len=0;serial_discard=false;
            }else if(bytes[i]!='\r'){if(!serial_discard&&serial_len<PET_FRAME_MAX)serial_line[serial_len++]=(char)bytes[i];else serial_discard=true;}
        }
        xSemaphoreGive(lock);
    }
}
static bool finish_trial(void){
    stop_client(); /* Certificate pointers must be released before either buffer changes. */
    pet_config_t *next=malloc(sizeof(*next));bool saved=false;
    if(next){*next=config;if(pet_config_commit(next,&candidate)&&persist(next)){xSemaphoreTake(lock,portMAX_DELAY);config=*next;pet_action_init(&host_action,device_boot_id);action_command_pending=false;xSemaphoreGive(lock);saved=true;}memset(next,0,sizeof(*next));free(next);}
    xSemaphoreTake(lock,portMAX_DELAY);trial=false;trial_snapshot=false;clear_candidate();fresh_view();xSemaphoreGive(lock);
    status(saved?"Settings verified and saved":"Candidate failed; settings retained");acknowledge(saved?"configured":"candidate_failed");pet_runtime_phase("trial-finished");return saved;
}
static void apply_settings(pet_settings_action_t action){
    stop_client();esp_err_t result=ESP_FAIL;bool cleanup_failed=false;
    if(action==PET_SETTINGS_FACTORY_RESET){result=nvs_erase_all(store);if(result==ESP_OK)result=nvs_commit(store);nvs_handle_t id;if(result==ESP_OK){result=nvs_open("pet_identity",NVS_READWRITE,&id);if(result==ESP_OK){result=nvs_erase_all(id);if(result==ESP_OK)result=nvs_commit(id);nvs_close(id);}}}
    else{
        pet_config_t *next=malloc(sizeof(*next));
        if(next){
            *next=config;
            if(action==PET_SETTINGS_FORGET_WIFI){memset(next->networks,0,sizeof(next->networks));next->network_count=0;next->active_network=0;}
            else{
                unsigned mode=action==PET_SETTINGS_DISABLE_REMOTE?PET_TRANSPORT_REMOTE:PET_TRANSPORT_LOCAL;
                memset(&next->transport[mode],0,sizeof(next->transport[mode]));
                /* Keep the selected mode unpaired; never opt into the other
                 * service merely because this profile was removed. */
            }
            if(persist(next)){
                xSemaphoreTake(lock,portMAX_DELAY);config=*next;pet_action_init(&host_action,device_boot_id);action_command_pending=false;trial=false;trial_snapshot=false;clear_candidate();fresh_view();xSemaphoreGive(lock);
                bool unpair=action==PET_SETTINGS_UNPAIR||action==PET_SETTINGS_DISABLE_REMOTE;
                result=unpair?pet_provision_forget_service(action==PET_SETTINGS_DISABLE_REMOTE):ESP_OK;
                cleanup_failed=result!=ESP_OK;
            }
            memset(next,0,sizeof(*next));free(next);
        }
    }
    if(result==ESP_OK)esp_restart();
    status(cleanup_failed?"Unpaired; root cleanup failed, retry":"Settings operation failed; retry");
}
static void runtime(void*arg){
    (void)arg;uint32_t next_connect=0,time_retry=0,wifi_retry=0,connected_at=0;unsigned failures=0,network_index=config.active_network;bool was_ble=false,was_usb=false;
    if(network_ready&&config.network_count)connect_wifi(&config.networks[network_index]);
    for(;;){
        uint32_t events=0;xTaskNotifyWait(0,UINT32_MAX,&events,pdMS_TO_TICKS(25));
        bool ble=pet_provision_active();
        xSemaphoreTake(lock,portMAX_DELAY);ble=ble||pause_requested;xSemaphoreGive(lock);
        serial_process(ble);uint32_t now=millis();bool configure_view=false;
        wifi_ap_record_t associated={0};
        bool have_association=(events&EV_WIFI_UP)&&pending_wifi_up&&esp_wifi_sta_get_ap_info(&associated)==ESP_OK;
        xSemaphoreTake(lock,portMAX_DELAY);
        ble=ble||pause_requested;
        bool usb=window_open();if(setup_until&&!usb)setup_until=0;
        if(pending&&!usb)clear_candidate();
        if(events&(EV_WIFI_UP|EV_WIFI_DOWN)){wifi_up=pending_wifi_up;snprintf(status_text,sizeof(status_text),"%s",wifi_up?"Wi-Fi ready; connecting service":"Wi-Fi disconnected; retrying");}
        if(wifi_up&&have_association&&!trial){
            for(unsigned i=0;i<config.network_count;i++)if(!strncmp((const char*)associated.ssid,config.networks[i].ssid,sizeof(associated.ssid))){config.active_network=(uint8_t)i;network_index=i;break;}
        }
        bool restart=reconnect;reconnect=false;
        if(events&EV_WS_DOWN){model.current.source_fresh=false;snprintf(status_text,sizeof(status_text),"Service disconnected; retrying");}
        if((was_usb&&!usb)||(was_ble&&!ble)){fresh_view();restart=true;}
        bool cancel=cancel_requested;cancel_requested=false;if(cancel)cancel_processing=true;
        bool apply=!trial&&!ble&&!cancel_processing&&((pending&&confirmed&&usb)||(candidate_queued&&!pending&&!usb));
        if(apply){if(candidate.has_profile&&candidate.profile.endpoint[0]&&pet_config_network_slot(&config,&candidate)>=0){trial=true;trial_started=now;trial_snapshot=false;setup_until=0;usb=false;pending=false;confirmed=false;candidate_queued=false;fresh_view();restart=true;}else{apply=false;clear_candidate();snprintf(status_text,sizeof(status_text),"Trusted service/network required");}}
        if(rx_ready){pet_result_t r=pet_model_ingest(&model,rx,rx_len,now);if(r==PET_ACTION_CONTROL&&authenticated){ingest_action_frame(rx,rx_len);last_received=now;}memset(rx,0,sizeof(rx));rx_ready=false;
            if(r==PET_WELCOME){authenticated=true;auth_started=0;last_received=now;configure_view=connection_mode==PET_TRANSPORT_LOCAL;snprintf(status_text,sizeof(status_text),"Authenticated; waiting for source");}
            if(r==PET_APPLIED){last_received=now;if(model.current.valid&&!model.synchronizing){snprintf(status_text,sizeof(status_text),"Service synchronized");if(trial&&authenticated)trial_snapshot=true;}}
        }
        if(auth_started&&!authenticated&&now-auth_started>5000){restart=true;snprintf(status_text,sizeof(status_text),"Authentication timed out");}
        if(client&&authenticated&&now-last_received>45000){restart=true;model.current.source_fresh=false;snprintf(status_text,sizeof(status_text),"Service data stale; reconnecting");}
        revalidate_action();pet_model_tick(&model,now);if(model.needs_resync){if(usb)serial_resync_pending=true;restart=true;model.needs_resync=false;model.last_frame_ms=now;}
        bool save_privacy=privacy_save;privacy_save=false;bool pub=model.public_mode;
        pet_settings_action_t action=settings_action;settings_action=0;
        xSemaphoreGive(lock);
        if(cancel){stop_client();xSemaphoreTake(lock,portMAX_DELAY);trial=false;trial_snapshot=false;clear_candidate();fresh_view();cancel_processing=false;privacy_save=privacy_save||save_privacy;if(action)settings_action=action;xSemaphoreGive(lock);network_index=config.active_network;if(config.network_count)connect_wifi(&config.networks[network_index]);else if(network_ready)esp_wifi_disconnect();next_connect=now+1000;status("Setup cancelled; settings retained");continue;}
        if(save_privacy&&storage_ready&&(nvs_set_u8(store,"public",pub?1:0)!=ESP_OK||nvs_commit(store)!=ESP_OK))status("Privacy setting save failed");
        if(configure_view&&client&&!restart&&!ble&&!usb)configure_local_view();
        if(action){if(storage_ready&&!ble)apply_settings(action);else status("Settings unavailable during setup");continue;}
        if(ble&&!was_ble)pet_runtime_phase("ble-window");
        if(was_ble&&!ble){pet_runtime_phase("ble-cleanup-complete");if(!trial&&config.network_count)connect_wifi(&config.networks[network_index]);}
        was_ble=ble;was_usb=usb;
        if(restart||ble||usb||(events&EV_WS_DOWN)){stop_client();if(!ble&&!usb){unsigned delay=1u<<(failures<5?failures:5);if(delay>30)delay=30;next_connect=now+delay*1000u+(esp_random()%401u)-200u;if(failures<10)failures++;}}
        if(ble){xSemaphoreTake(lock,portMAX_DELAY);if(pause_requested)pause_acknowledged=true;xSemaphoreGive(lock);}
        if(apply){if(candidate.utc_seconds){struct timeval t={.tv_sec=candidate.utc_seconds};settimeofday(&t,NULL);candidate.utc_seconds=0;}int slot=pet_config_network_slot(&config,&candidate);const pet_network_t*n=candidate.has_network?&candidate.network:&config.networks[slot];status("Testing candidate network/service");connect_wifi(n);next_connect=now;pet_runtime_phase("candidate-start");}
        if(trial&&(trial_snapshot||now-trial_started>30000)){
            if(trial_snapshot)finish_trial();else{stop_client();xSemaphoreTake(lock,portMAX_DELAY);trial=false;clear_candidate();fresh_view();xSemaphoreGive(lock);status("Candidate failed; settings retained");acknowledge("candidate_failed");}
            network_index=config.active_network;if(config.network_count)connect_wifi(&config.networks[network_index]);next_connect=now+1000;continue;
        }
        if(events&EV_WS_UP){if(client&&connection&&!ble&&!usb){connected_at=now;handshake();pet_runtime_phase("tls-connected");}}
        if(authenticated&&connected_at&&now-connected_at>=60000)failures=0;
        if(!ble&&!usb&&network_ready&&!wifi_up&&now-wifi_retry>=10000){wifi_retry=now;if(trial){int slot=pet_config_network_slot(&config,&candidate);if(slot>=0)connect_wifi(candidate.has_network?&candidate.network:&config.networks[slot]);}else if(config.network_count){network_index=(network_index+1)%config.network_count;connect_wifi(&config.networks[network_index]);}}
        if(!ble&&!usb&&wifi_up&&!client&&(int32_t)(now-next_connect)>=0){
            const pet_transport_config_t*p=trial?&candidate.profile:&config.transport[config.mode];
            if(!p->endpoint[0])continue;
            if(time(NULL)<1735689600){if(p->time_url[0]&&p->time_key[0]&&p->time_issuer[0]){if(!time_retry||now-time_retry>=30000){time_retry=now;status("Recovering signed service time");if(pet_time_recover(p->time_url,p->time_key,p->time_issuer)!=ESP_OK)status("Signed time failed: USB repair");}}else status("Clock unknown: USB time repair");continue;}
            connection=p;connection_mode=trial?candidate.target:(pet_transport_t)config.mode;
            esp_websocket_client_config_t c={.uri=p->endpoint,.cert_pem=p->ca[0]?p->ca:NULL,.crt_bundle_attach=p->ca[0]?NULL:esp_crt_bundle_attach,.cert_common_name=p->server[0]?p->server:NULL,.skip_cert_common_name_check=false,.buffer_size=1024,.task_stack=6144,.disable_auto_reconnect=true,.network_timeout_ms=5000};
            pet_runtime_phase("tls-start");client=esp_websocket_client_init(&c);
            if(!client||esp_websocket_register_events(client,WEBSOCKET_EVENT_ANY,ws_event,NULL)!=ESP_OK||esp_websocket_client_start(client)!=ESP_OK){stop_client();next_connect=now+10000;status("TLS/service start failed");}
        }
        bool policy=false,resync=false;
        xSemaphoreTake(lock,portMAX_DELAY);if(window_open()&&!pause_requested&&!trial){policy=serial_policy_pending;resync=serial_resync_pending;}xSemaphoreGive(lock);
        if(policy||resync){char sent_epoch[65];bool ok=serial_control(policy,sent_epoch);if(ok){xSemaphoreTake(lock,portMAX_DELAY);if(!strcmp(sent_epoch,model.view_epoch)){if(policy)serial_policy_pending=false;else serial_resync_pending=false;}xSemaphoreGive(lock);}}
        dispatch_action();
    }
}
static void load_config(void){
    memset(&config,0,sizeof(config));config.version=PET_CONFIG_VERSION;
    size_t size=sizeof(config);esp_err_t result=nvs_get_blob(store,"config2",&config,&size);
    if(result==ESP_OK&&size==sizeof(config)&&pet_config_valid(&config))return;
    memset(&config,0,sizeof(config));config.version=PET_CONFIG_VERSION;
    if(result!=ESP_ERR_NVS_NOT_FOUND)return; /* Never reinterpret a damaged v2 blob. */
    /* V1 layout: 98B network + contiguous transport fields + aligned UTC word.
     * Candidate workspace is larger than the old 3600-byte blob, avoiding a
     * resident legacy copy or a 3.6KB allocation on the small main-task stack. */
    _Static_assert(sizeof(pet_candidate_t)>=3600,"legacy workspace too small");
    size=3600;if(nvs_get_blob(store,"config",&candidate,&size)!=ESP_OK||size!=3600){clear_candidate();return;}
    pet_network_t old_network;memcpy(&old_network,&candidate,sizeof(old_network));
    memmove(&candidate.profile,(unsigned char*)&candidate+sizeof(old_network),sizeof(candidate.profile));
    if(pet_config_profile_valid(&candidate.profile)&&memchr(old_network.ssid,0,33)&&memchr(old_network.key,0,65)){
        config.transport[PET_TRANSPORT_LOCAL]=candidate.profile;
        if(old_network.ssid[0]){config.networks[0]=old_network;config.network_count=1;}
    }
    clear_candidate();
}
static bool start_network(void){
    if(esp_netif_init()!=ESP_OK||esp_event_loop_create_default()!=ESP_OK)return false;
    esp_netif_config_t nc=ESP_NETIF_DEFAULT_WIFI_STA();esp_netif_t*station=esp_netif_new(&nc);if(!station)return false;
    if(esp_netif_attach_wifi_station(station)!=ESP_OK||esp_wifi_set_default_wifi_sta_handlers()!=ESP_OK){esp_netif_destroy_default_wifi(station);return false;}
    wifi_init_config_t w=WIFI_INIT_CONFIG_DEFAULT();if(esp_wifi_init(&w)!=ESP_OK){esp_netif_destroy_default_wifi(station);return false;}
    bool wh=false,ih=false;esp_err_t e=esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if(e==ESP_OK)e=esp_wifi_set_mode(WIFI_MODE_STA);
    if(e==ESP_OK){e=esp_event_handler_register(WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,wifi_event,NULL);wh=e==ESP_OK;}
    if(e==ESP_OK){e=esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL);ih=e==ESP_OK;}
    if(e==ESP_OK)e=esp_wifi_start();
    if(e!=ESP_OK){if(ih)esp_event_handler_unregister(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event);if(wh)esp_event_handler_unregister(WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,wifi_event);esp_wifi_deinit();esp_netif_destroy_default_wifi(station);return false;}
    return true;
}
void pet_runtime_start(void){
    lock=xSemaphoreCreateMutex();if(!lock)return;heap_caps_register_failed_alloc_callback(failed_allocation);
    const esp_app_desc_t *app=esp_app_get_description();for(unsigned i=0;i<32;i++)snprintf(firmware_sha+i*2,3,"%02x",app->app_elf_sha256[i]);
    char e[65];epoch(e);pet_model_init(&model,e);config.version=PET_CONFIG_VERSION;
    storage_ready=nvs_flash_init()==ESP_OK&&nvs_open("agentpet",NVS_READWRITE,&store)==ESP_OK;
    if(storage_ready){load_config();uint8_t pub=0;if(nvs_get_u8(store,"public",&pub)==ESP_OK&&pub)model.public_mode=true;}
    network_ready=start_network();
    epoch(device_boot_id);pet_action_init(&host_action,device_boot_id);
    usb_serial_jtag_driver_config_t u={.tx_buffer_size=1024,.rx_buffer_size=4608};
    if(usb_serial_jtag_driver_install(&u)!=ESP_OK){status("USB unavailable");return;}
    usb_serial_jtag_vfs_use_driver();
    if(!storage_ready)status("Storage unavailable; not erased");else if(!network_ready)status("Network unavailable; USB works");
    if(xTaskCreate(runtime,"pet_network",14336,NULL,6,&worker)!=pdPASS)status("Worker allocation failed");
    pet_runtime_phase("network-ready");
}
