#include "agent_pet_config.h"
#include <string.h>
#include <stdio.h>
static bool terminated(const char*s,size_t n){return memchr(s,0,n)!=NULL;}
static bool printable(const char*s){for(;*s;s++)if((unsigned char)*s<33||(unsigned char)*s>126||*s=='"'||*s=='\\')return false;return true;}
static bool url(const char*s,const char*scheme){return !strncmp(s,scheme,strlen(scheme))&&s[strlen(scheme)]&&!strpbrk(s,"@?#")&&printable(s);}
bool pet_config_profile_valid(const pet_transport_config_t*p){
    if(!terminated(p->endpoint,sizeof(p->endpoint))||!terminated(p->token,sizeof(p->token))||!terminated(p->ca,sizeof(p->ca))||!terminated(p->server,sizeof(p->server))||!terminated(p->device_id,sizeof(p->device_id))||!terminated(p->time_url,sizeof(p->time_url))||!terminated(p->time_issuer,sizeof(p->time_issuer))||!terminated(p->time_key,sizeof(p->time_key)))return false;
    if(!p->endpoint[0])return !p->token[0];
    return url(p->endpoint,"wss://")&&strlen(p->token)>=43&&printable(p->token)&&p->device_id[0]&&printable(p->device_id)&&printable(p->server)&&(!p->time_url[0]||(url(p->time_url,"http://")&&p->time_issuer[0]&&printable(p->time_issuer)&&p->time_key[0]));
}
bool pet_config_valid(const pet_config_t*c){
    if(c->version!=PET_CONFIG_VERSION||c->network_count>PET_NETWORK_MAX||c->mode>1||(c->network_count&&c->active_network>=c->network_count))return false;
    for(unsigned i=0;i<2;i++)if(!pet_config_profile_valid(&c->transport[i]))return false;
    for(unsigned i=0;i<c->network_count;i++){
        if(!terminated(c->networks[i].ssid,33)||!c->networks[i].ssid[0]||!terminated(c->networks[i].key,65))return false;
        for(unsigned k=0;k<i;k++)if(!strcmp(c->networks[i].ssid,c->networks[k].ssid))return false;
    }
    return true;
}
static bool field(const pet_json_t*j,const char*k,char*out,size_t n,bool optional,bool pem){
    int t=pet_json_field(j,0,k);if(t<0)return optional;
    return pem?pet_json_pem_string(j,t,out,n):pet_json_string(j,t,out,n);
}
bool pet_config_parse_setup(const char*s,size_t n,pet_candidate_t*c){
    pet_json_t j;uint32_t v;
    memset(c,0,sizeof(*c));c->replace_slot=-1;
    if(!pet_json_parse(&j,s,n)||!pet_json_uint(&j,pet_json_field(&j,0,"v"),&v)||v!=1||!pet_json_is(&j,pet_json_field(&j,0,"type"),"setup"))return false;
    int t=pet_json_field(&j,0,"transport");
    if(t>=0){if(pet_json_is(&j,t,"remote"))c->target=PET_TRANSPORT_REMOTE;else if(!pet_json_is(&j,t,"local"))return false;}
    t=pet_json_field(&j,0,"ssid");
    if(t>=0){
        c->has_network=true;
        if(!field(&j,"ssid",c->network.ssid,33,false,false)||!c->network.ssid[0]||!field(&j,"pass" "word",c->network.key,65,false,false))return false;
    }else if(pet_json_field(&j,0,"pass" "word")>=0)return false;
    t=pet_json_field(&j,0,"replace_slot");
    if(t>=0){if(pet_json_is(&j,t,"-1")&&j.t[t].kind!='"')c->replace_slot=-1;else{if(!pet_json_uint(&j,t,&v)||v>=PET_NETWORK_MAX)return false;c->replace_slot=(int)v;}}
    pet_transport_config_t*p=&c->profile;
    if(!field(&j,"endpoint",p->endpoint,sizeof(p->endpoint),false,false)||!field(&j,"token",p->token,sizeof(p->token),false,false)||!field(&j,"ca_pem",p->ca,sizeof(p->ca),true,true)||!field(&j,"server_name",p->server,sizeof(p->server),true,false)||!field(&j,"device_id",p->device_id,sizeof(p->device_id),true,false)||!field(&j,"time_bootstrap_url",p->time_url,sizeof(p->time_url),true,false)||!field(&j,"time_issuer",p->time_issuer,sizeof(p->time_issuer),true,false)||!field(&j,"enrollment_public_key_pem",p->time_key,sizeof(p->time_key),true,true))return false;
    if(!p->device_id[0])snprintf(p->device_id,sizeof(p->device_id),"passport-1");
    if(!pet_json_uint(&j,pet_json_field(&j,0,"time"),&c->utc_seconds)||c->utc_seconds<1735689600u||c->utc_seconds>4102444800u||!pet_config_profile_valid(p)||!p->endpoint[0])return false;
    c->has_profile=true;return true;
}
int pet_config_network_slot(const pet_config_t*c,const pet_candidate_t*p){
    if(!p->has_network)return c->network_count?(int)c->active_network:-1;
    if(!p->network.ssid[0]||!terminated(p->network.ssid,33)||!terminated(p->network.key,65)||p->replace_slot < -1)return -1;
    if(p->replace_slot>=0){if(p->replace_slot>PET_NETWORK_MAX-1||p->replace_slot>(int)c->network_count)return -1;for(unsigned i=0;i<c->network_count;i++)if((int)i!=p->replace_slot&&!strcmp(c->networks[i].ssid,p->network.ssid))return -1;return p->replace_slot;}
    for(unsigned i=0;i<c->network_count;i++)if(!strcmp(c->networks[i].ssid,p->network.ssid))return (int)i;
    return c->network_count<PET_NETWORK_MAX?(int)c->network_count:-1;
}
bool pet_config_commit(pet_config_t*c,const pet_candidate_t*p){
    int slot=pet_config_network_slot(c,p);
    if(slot<0||(unsigned)p->target>PET_TRANSPORT_REMOTE||!pet_config_profile_valid(&p->profile)||!p->profile.endpoint[0])return false;
    if(p->has_network){c->networks[slot]=p->network;if(slot==c->network_count)c->network_count++;}
    c->transport[p->target]=p->profile;c->mode=(uint8_t)p->target;c->active_network=(uint8_t)slot;c->version=PET_CONFIG_VERSION;return true;
}
