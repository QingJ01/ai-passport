#include "agent_pet_time.h"
#include "esp_http_client.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/ecp.h"
#include "mbedtls/sha256.h"
#include "cJSON.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

typedef struct { char body[1025]; size_t used; bool overflow; } response_t;
static esp_err_t receive(esp_http_client_event_t *event)
{
    response_t *reply=event->user_data;
    if(event->event_id==HTTP_EVENT_ON_DATA&&event->data_len>0){
        if(reply->used+(size_t)event->data_len>=sizeof(reply->body)){
            reply->overflow=true;
            return ESP_ERR_NO_MEM;
        }
        memcpy(reply->body+reply->used,event->data,event->data_len);
        reply->used+=(size_t)event->data_len;
        reply->body[reply->used]=0;
    }
    return ESP_OK;
}
static const char *field(cJSON *object,const char *name,size_t limit)
{
    cJSON *value=cJSON_GetObjectItemCaseSensitive(object,name);
    return cJSON_IsString(value)&&strlen(value->valuestring)<limit?value->valuestring:NULL;
}
static bool identity(const char *value)
{
    if(!value||!value[0]||strlen(value)>64)return false;
    for(const char *p=value;*p;p++)if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='-'||*p=='_'))return false;
    return true;
}
static bool decode(const char *text,unsigned char *out,size_t *length)
{
    char input[145];size_t size=strlen(text);
    if(size>140)return false;
    for(size_t i=0;i<size;i++){
        char c=text[i];
        if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'))return false;
        input[i]=c=='-'?'+':c=='_'?'/':c;
    }
    while(size%4)input[size++]='=';
    return mbedtls_base64_decode(out,80,length,(unsigned char*)input,size)==0;
}
esp_err_t pet_time_recover(const char *url,const char *pem,const char *issuer)
{
    if(!url||!pem||!pem[0]||strlen(pem)>511||!identity(issuer)||strncmp(url,"http://",7)||strlen(url)>256||strchr(url,'@')||strchr(url,'?')||strchr(url,'#'))return ESP_ERR_INVALID_ARG;
    char nonce[65];
    for(size_t i=0;i<8;i++)snprintf(nonce+8*i,9,"%08lx",(unsigned long)esp_random());
    char target[340];
    if(snprintf(target,sizeof(target),"%s?nonce=%s",url,nonce)>=(int)sizeof(target))return ESP_ERR_INVALID_ARG;
    response_t reply={0};
    esp_http_client_config_t config={.url=target,.method=HTTP_METHOD_GET,.timeout_ms=4500,.event_handler=receive,.user_data=&reply,.disable_auto_redirect=true,.buffer_size=512,.buffer_size_tx=512};
    esp_http_client_handle_t client=esp_http_client_init(&config);
    if(!client)return ESP_ERR_NO_MEM;
    int64_t start=esp_timer_get_time();
    esp_err_t result=esp_http_client_perform(client);
    int status=esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if(result!=ESP_OK||status!=200||reply.overflow||esp_timer_get_time()-start>5000000)return ESP_FAIL;
    /* The response is small and flat; reject deeper untrusted JSON before parse. */
    unsigned depth=0;bool quoted=false,escape=false;
    for(size_t i=0;i<reply.used;i++){
        char c=reply.body[i];if(!c)return ESP_FAIL;
        if(quoted){if(escape)escape=false;else if(c=='\\')escape=true;else if(c=='"')quoted=false;}
        else if(c=='"')quoted=true;
        else if(c=='{'||c=='['){if(++depth>2)return ESP_FAIL;}
        else if(c=='}'||c==']'){if(!depth)return ESP_FAIL;depth--;}
    }
    if(depth||quoted)return ESP_FAIL;
    cJSON *object=cJSON_ParseWithLength(reply.body,reply.used);
    if(!object)return ESP_FAIL;
    const char *returned_issuer=field(object,"issuer",65),*returned_nonce=field(object,"nonce",65),*seconds=field(object,"unix_seconds",11),*signature=field(object,"signature",141);
    bool valid=returned_issuer&&returned_nonce&&seconds&&signature&&!strcmp(returned_issuer,issuer)&&!strcmp(returned_nonce,nonce)&&strlen(seconds)==10;
    uint64_t timestamp=0;
    if(valid){for(const char *p=seconds;*p;p++){if(*p<'0'||*p>'9'){valid=false;break;}timestamp=timestamp*10+(unsigned)(*p-'0');}}
    valid=valid&&timestamp>=1735689600&&timestamp<=4102444800ULL;
    unsigned char signature_bytes[80],hash[32];size_t signature_length=0;
    if(valid)valid=decode(signature,signature_bytes,&signature_length);
    char canonical[180];
    if(valid){
        int length=snprintf(canonical,sizeof(canonical),"agentpet-time-v1\n%s\n%s\n%s",issuer,nonce,seconds);
        valid=length>0&&(size_t)length<sizeof(canonical);
        if(valid)mbedtls_sha256((unsigned char*)canonical,(size_t)length,hash,0);
    }
    mbedtls_pk_context key;mbedtls_pk_init(&key);
    if(valid)valid=mbedtls_pk_parse_public_key(&key,(unsigned char*)pem,strlen(pem)+1)==0&&mbedtls_pk_can_do(&key,MBEDTLS_PK_ECDSA)&&mbedtls_ecp_keypair_get_group_id(mbedtls_pk_ec(key))==MBEDTLS_ECP_DP_SECP256R1&&mbedtls_pk_verify(&key,MBEDTLS_MD_SHA256,hash,sizeof(hash),signature_bytes,signature_length)==0;
    mbedtls_pk_free(&key);cJSON_Delete(object);
    if(!valid)return ESP_FAIL;
    struct timeval now={.tv_sec=(time_t)timestamp};
    return settimeofday(&now,NULL)==0?ESP_OK:ESP_FAIL;
}
