#include "agent_pet_action.h"
#include <stdio.h>
#include <string.h>
static bool hexadecimal(const char*s){if(!s||strlen(s)!=32)return false;for(;*s;s++)if(!((*s>='0'&&*s<='9')||(*s>='a'&&*s<='f')))return false;return true;}
static bool token_valid(const char*s){size_t n=strlen(s);if(n<43||n>128)return false;for(;*s;s++)if(!((*s>='a'&&*s<='z')||(*s>='A'&&*s<='Z')||(*s>='0'&&*s<='9')||*s=='_'||*s=='-'))return false;return true;}
void pet_action_init(pet_action_t*a,const char*boot){memset(a,0,sizeof(*a));if(boot&&hexadecimal(boot))memcpy(a->boot_id,boot,33);}
static bool pending(const pet_action_t*a){return a->phase==PET_ACTION_SENT||a->phase==PET_ACTION_ACCEPTED||a->phase==PET_ACTION_UNKNOWN;}
void pet_action_tick(pet_action_t*a,uint32_t now){
    if((a->phase==PET_ACTION_PREPARING||a->phase==PET_ACTION_READY)&&(int32_t)(now-a->deadline_ms)>=0){a->phase=PET_ACTION_EXPIRED;memset(a->token,0,sizeof(a->token));}
    else if((a->phase==PET_ACTION_SENT||a->phase==PET_ACTION_ACCEPTED)&&(int32_t)(now-a->deadline_ms)>=0)a->phase=PET_ACTION_UNKNOWN;
}
bool pet_action_begin(pet_action_t*a,const char*target,uint64_t revision,const char*id,uint32_t now){
    if(!target||!target[0]||strlen(target)>PET_ID_MAX||revision>PET_JS_SAFE_MAX||!hexadecimal(id)||!hexadecimal(a->boot_id)||pending(a))return false;
    memset(a->token,0,sizeof(a->token));snprintf(a->target_id,sizeof(a->target_id),"%s",target);memcpy(a->action_id,id,33);a->target_revision=revision;a->phase=PET_ACTION_PREPARING;a->deadline_ms=now+5000;return true;
}
void pet_action_hide_private(pet_action_t*a){
    bool dispatched=pending(a);memset(a->target_id,0,sizeof(a->target_id));memset(a->token,0,sizeof(a->token));a->target_revision=0;
    if(dispatched)a->phase=PET_ACTION_UNKNOWN;
    else{a->phase=PET_ACTION_IDLE;memset(a->action_id,0,sizeof(a->action_id));}
}
bool pet_action_confirm(pet_action_t*a,uint64_t revision,uint32_t now){
    pet_action_tick(a,now);
    if(a->phase!=PET_ACTION_READY)return false;
    if(revision!=a->target_revision){a->phase=PET_ACTION_CONFLICT;memset(a->token,0,sizeof(a->token));return false;}
    a->phase=PET_ACTION_SENT;a->deadline_ms=now+35000;return true;
}
static bool string(const pet_json_t*j,int obj,const char*key,char*out,size_t n){return pet_json_string(j,pet_json_field(j,obj,key),out,n);}
static unsigned decimal(const char*s,unsigned n){unsigned v=0;for(unsigned i=0;i<n;i++){if(s[i]<'0'||s[i]>'9')return UINT32_MAX;v=v*10+(unsigned)(s[i]-'0');}return v;}
static uint64_t expiry_ms(const char*s){
    if(strlen(s)!=24||s[4]!='-'||s[7]!='-'||s[10]!='T'||s[13]!=':'||s[16]!=':'||s[19]!='.'||s[23]!='Z')return 0;
    unsigned y=decimal(s,4),m=decimal(s+5,2),d=decimal(s+8,2),h=decimal(s+11,2),min=decimal(s+14,2),sec=decimal(s+17,2),ms=decimal(s+20,3);
    static const unsigned days[]={31,28,31,30,31,30,31,31,30,31,30,31};
    if(y<2020||y>2100||m<1||m>12||d<1||h>23||min>59||sec>59||ms>999)return 0;
    unsigned leap=(y%4==0&&(y%100!=0||y%400==0))?1u:0u;if(d>days[m-1]+(m==2?leap:0))return 0;
    unsigned yy=y-(m<=2),era=yy/400,yoe=yy-era*400,month=m>2?m-3:m+9;
    unsigned doy=(153*month+2)/5+d-1,doe=yoe*365+yoe/4-yoe/100+doy;
    uint64_t total=(uint64_t)era*146097+doe-719468;
    return ((total*24+h)*60+min)*60000+(uint64_t)sec*1000+ms;
}
bool pet_action_ingest(pet_action_t*a,const char*s,size_t n,const char*epoch,const char*stream,uint32_t now,uint64_t utc){
    pet_json_t j;uint32_t v;char kind[24],view[65],publication[65];
    if(!pet_json_parse(&j,s,n)||!pet_json_uint(&j,pet_json_field(&j,0,"v"),&v)||v!=1||!string(&j,0,"type",kind,sizeof(kind))||!string(&j,0,"view_epoch",view,sizeof(view))||strcmp(view,epoch)||!string(&j,0,"stream_id",publication,sizeof(publication))||strcmp(publication,stream))return false;
    pet_action_tick(a,now);int p=pet_json_field(&j,0,"payload");if(p<0||j.t[p].kind!='{')return false;
    if(!strcmp(kind,"action.offer")){
        if(a->phase!=PET_ACTION_PREPARING)return false;
        char type[24],target[PET_ID_MAX+1],token[129],expires[25];uint64_t rev;
        if(!string(&j,p,"type",type,sizeof(type))||strcmp(type,"open_on_host")||!string(&j,p,"target_id",target,sizeof(target))||strcmp(target,a->target_id)||!pet_json_uint64(&j,pet_json_field(&j,p,"target_revision"),&rev)||rev!=a->target_revision||!string(&j,p,"token",token,sizeof(token))||!token_valid(token)||!string(&j,p,"expires_at",expires,sizeof(expires)))return false;
        uint64_t expiration=expiry_ms(expires);if(!expiration)return false;
        uint32_t ttl=10000; /* Unknown wall clock over USB: bounded local consent. */
        if(utc){if(expiration<=utc){a->phase=PET_ACTION_EXPIRED;return true;}uint64_t remaining=expiration-utc;ttl=remaining<25000?(uint32_t)remaining:25000;}
        memcpy(a->token,token,strlen(token)+1);memset(token,0,sizeof(token));a->deadline_ms=now+ttl;a->phase=PET_ACTION_READY;return true;
    }
    if(!strcmp(kind,"action.result")){
        char id[33],status[24];if(!a->action_id[0]||!string(&j,p,"action_id",id,sizeof(id))||strcmp(id,a->action_id)||!string(&j,p,"status",status,sizeof(status)))return false;
        if(!pending(a))return false;
        if(!strcmp(status,"accepted"))a->phase=PET_ACTION_ACCEPTED;
        else if(!strcmp(status,"succeeded"))a->phase=PET_ACTION_SUCCEEDED;
        else if(!strcmp(status,"failed"))a->phase=PET_ACTION_FAILED;
        else if(!strcmp(status,"conflict"))a->phase=PET_ACTION_CONFLICT;
        else if(!strcmp(status,"expired"))a->phase=PET_ACTION_EXPIRED;
        else if(!strcmp(status,"unknown"))a->phase=PET_ACTION_UNKNOWN;
        else return false;
        memset(a->token,0,sizeof(a->token));return true;
    }
    return false;
}
static int quoted(char*out,size_t cap,const char*s){size_t n=0;if(cap<3)return -1;out[n++]='"';for(;*s;s++){unsigned char c=(unsigned char)*s;if(c<32||c==127)return -1;if(c=='"'||c=='\\'){if(n+2>=cap)return -1;out[n++]='\\';}if(n+1>=cap)return -1;out[n++]=(char)c;}if(n+2>cap)return -1;out[n++]='"';out[n]=0;return (int)n;}
int pet_action_compose(const pet_action_t*a,pet_action_command_t command,const char*epoch,char*out,size_t cap){
    char target[2*PET_ID_MAX+3];if(quoted(target,sizeof(target),a->target_id)<0||!hexadecimal(a->boot_id)||!hexadecimal(a->action_id))return -1;
    int n=-1;
    if(command==PET_ACTION_PREPARE_COMMAND&&a->phase==PET_ACTION_PREPARING)n=snprintf(out,cap,"{\"v\":1,\"type\":\"action.prepare\",\"view_epoch\":\"%s\",\"payload\":{\"target_id\":%s}}",epoch,target);
    else if(command==PET_ACTION_EXECUTE_COMMAND&&a->phase==PET_ACTION_SENT&&token_valid(a->token))n=snprintf(out,cap,"{\"v\":1,\"type\":\"action\",\"view_epoch\":\"%s\",\"payload\":{\"action_id\":\"%s\",\"device_boot_id\":\"%s\",\"type\":\"open_on_host\",\"target_id\":%s,\"target_revision\":%llu,\"token\":\"%s\",\"parameters\":{}}}",epoch,a->action_id,a->boot_id,target,(unsigned long long)a->target_revision,a->token);
    else if(command==PET_ACTION_QUERY_COMMAND&&pending(a))n=snprintf(out,cap,"{\"v\":1,\"type\":\"action.query\",\"view_epoch\":\"%s\",\"payload\":{\"action_id\":\"%s\"}}",epoch,a->action_id);
    return n>0&&(size_t)n<cap?n:-1;
}
const char *pet_action_status(pet_action_phase_t p){
    static const char*text[]={"No host request","Preparing secure offer","Ready to open host view","Sent; awaiting host","Accepted; host pending","Opened in host view","Host request failed","Result unknown; query status","Task changed or request conflicted","Offer expired; prepare again"};
    return (unsigned)p<sizeof(text)/sizeof(text[0])?text[p]:"Unknown request state";
}
