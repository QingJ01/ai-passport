#include "agent_pet_model.h"
#include <string.h>
#include <stdlib.h>
#include <limits.h>

static void ws(const char *s, int *p, int n) { while (*p < n && (s[*p]==' '||s[*p]=='\n'||s[*p]=='\r'||s[*p]=='\t')) ++*p; }
static int parse(pet_json_t *j, int *p, int n, int depth) {
    ws(j->text,p,n);
    if (*p>=n || depth>12 || j->count>=768) return -1;
    int k=j->count++; pet_json_token_t *t=&j->t[k]; t->start=*p;
    char c=j->text[(*p)++]; t->kind=(uint8_t)c;
    if(c=='{'||c=='[') {
        ws(j->text,p,n); char end=c=='{'?'}':']';
        if(*p<n && j->text[*p]==end) ++*p;
        else for (;;) {
            if(c=='{') { ws(j->text,p,n); if(*p>=n||j->text[*p]!='"'||parse(j,p,n,depth+1)<0) return -1; ws(j->text,p,n); if(*p>=n||j->text[(*p)++]!=':') return -1; }
            if(parse(j,p,n,depth+1)<0) return -1;
            ws(j->text,p,n); if(*p>=n) return -1;
            char sep=j->text[(*p)++]; if(sep==end) break; if(sep!=',') return -1;
        }
    } else if(c=='"') {
        bool done=false;
        while(*p<n) { unsigned char a=(unsigned char)j->text[(*p)++]; if(a=='"') { done=true;break; } if(a<32) return -1;
            if(a=='\\') { if(*p>=n) return -1; char e=j->text[(*p)++]; if(e=='u') { for(int x=0;x<4;x++) { if(*p>=n) return -1; char h=j->text[(*p)++]; if(!((h>='0'&&h<='9')||(h>='a'&&h<='f')||(h>='A'&&h<='F'))) return -1; } } else if(!strchr("\"\\/bfnrt",e)) return -1; }
        } if(!done) return -1;
    } else {
        while(*p<n && !strchr(",]} \r\n\t",j->text[*p])) ++*p;
        int a=t->start,b=*p;
        if(!((b-a==4&&!memcmp(j->text+a,"true",4))||(b-a==5&&!memcmp(j->text+a,"false",5))||(b-a==4&&!memcmp(j->text+a,"null",4)))) {
            if(j->text[a]=='-') a++;
            if(a==b) return -1;
            if(j->text[a]=='0'&&a+1<b) return -1;
            for(;a<b;a++) if(j->text[a]<'0'||j->text[a]>'9') return -1;
        }
    }
    t->end=*p; t->next=j->count; return k;
}
bool pet_json_parse(pet_json_t *j,const char *s,size_t n) {
    if(!s||!n||n>PET_FRAME_MAX) return false;
    j->text=s;j->count=0;int p=0;
    if(parse(j,&p,(int)n,0)!=0) return false;
    ws(s,&p,(int)n);if(p!=(int)n||j->t[0].kind!='{')return false;
    /* Reject duplicate and escaped keys, avoiding ambiguous security fields. */
    for(int o=0;o<j->count;o++)if(j->t[o].kind=='{'){
        for(int a=o+1;a<j->t[o].next;a=j->t[a+1].next){
            int size=j->t[a].end-j->t[a].start;
            if(memchr(s+j->t[a].start,'\\',size))return false;
            for(int b=o+1;b<a;b=j->t[b+1].next)
                if(j->t[b].end-j->t[b].start==size&&!memcmp(s+j->t[a].start,s+j->t[b].start,size))return false;
        }
    }
    return true;
}
bool pet_json_is(const pet_json_t *j,int t,const char *s) { if(t<0||t>=j->count) return false; int a=j->t[t].start,b=j->t[t].end;if(j->t[t].kind=='"'){a++;b--;}return (size_t)(b-a)==strlen(s)&&!memcmp(j->text+a,s,(size_t)(b-a)); }
int pet_json_field(const pet_json_t *j,int obj,const char *name) { if(obj<0||j->t[obj].kind!='{') return -1; int found=-1;for(int i=obj+1;i<j->t[obj].next;) { int v=i+1;if(pet_json_is(j,i,name)){if(found>=0)return -1;found=v;}i=j->t[v].next;}return found; }
static unsigned hex(char c) { return c<='9'?(unsigned)(c-'0'):(unsigned)((c|32)-'a'+10); }
static bool json_string(const pet_json_t *j,int t,char *out,size_t cap,bool pem) {
    if(t<0||j->t[t].kind!='"'||!cap)return false;
    size_t used=0; int p=j->t[t].start+1,end=j->t[t].end-1;
    while(p<end) { unsigned char c=(unsigned char)j->text[p++]; uint32_t cp=c;
        if(c=='\\') { c=(unsigned char)j->text[p++];if(c=='u'){cp=0;for(int i=0;i<4;i++)cp=(cp<<4)|hex(j->text[p++]);if(cp>=0xD800&&cp<=0xDBFF){if(p+6>end||j->text[p]!='\\'||j->text[p+1]!='u')return false;p+=2;uint32_t low=0;for(int i=0;i<4;i++)low=(low<<4)|hex(j->text[p++]);if(low<0xDC00||low>0xDFFF)return false;cp=0x10000+((cp-0xD800)<<10)+(low-0xDC00);}else if(cp>=0xDC00&&cp<=0xDFFF)return false;}else {if(c=='n')cp='\n';else if(c=='r')cp='\r';else if(c=='t')cp='\t';else if(c=='b'||c=='f')return false;else cp=c;} }
        else if(c>=128) { unsigned bytes=c>=0xF0?3:c>=0xE0?2:c>=0xC2?1:9;if(bytes>3||p+(int)bytes>end)return false;cp=c&((1u<<(6-bytes))-1);for(unsigned x=0;x<bytes;x++){unsigned char z=(unsigned char)j->text[p++];if((z&0xC0)!=0x80)return false;cp=(cp<<6)|(z&63);}if(cp< (bytes==1?128u:bytes==2?2048u:65536u)||cp>0x10FFFF||(cp>=0xD800&&cp<=0xDFFF))return false; }
        if((cp<32&&!(pem&&(cp=='\n'||cp=='\r')))||cp==127)return false;
        unsigned char b[4];size_t count;if(cp<128){b[0]=cp;count=1;}else if(cp<2048){b[0]=0xC0|(cp>>6);b[1]=0x80|(cp&63);count=2;}else if(cp<65536){b[0]=0xE0|(cp>>12);b[1]=0x80|((cp>>6)&63);b[2]=0x80|(cp&63);count=3;}else{b[0]=0xF0|(cp>>18);b[1]=0x80|((cp>>12)&63);b[2]=0x80|((cp>>6)&63);b[3]=0x80|(cp&63);count=4;}
        if(used+count>=cap)return false;
        memcpy(out+used,b,count);
        used+=count;
    }out[used]=0;return true;
}
bool pet_json_string(const pet_json_t*j,int t,char*out,size_t cap){return json_string(j,t,out,cap,false);}
bool pet_json_pem_string(const pet_json_t*j,int t,char*out,size_t cap){return json_string(j,t,out,cap,true);}
bool pet_json_uint64(const pet_json_t*j,int t,uint64_t*out){
    if(t<0)return false;
    uint64_t n=0;for(int i=j->t[t].start;i<j->t[t].end;i++){char c=j->text[i];if(c<'0'||c>'9')return false;unsigned digit=(unsigned)(c-'0');if(n>(PET_SAFE_INTEGER_MAX-digit)/10)return false;n=n*10+digit;}*out=n;return true;
}
bool pet_json_uint(const pet_json_t *j,int t,uint32_t *out) { if(t<0)return false;uint64_t n=0;for(int i=j->t[t].start;i<j->t[t].end;i++){char c=j->text[i];if(c<'0'||c>'9')return false;n=n*10+(unsigned)(c-'0');if(n>UINT32_MAX)return false;}*out=(uint32_t)n;return true; }
bool pet_json_bool(const pet_json_t *j,int t,bool *out) { if(t<0||j->t[t].kind=='"')return false;if(pet_json_is(j,t,"true")){*out=true;return true;}if(pet_json_is(j,t,"false")){*out=false;return true;}return false; }
static bool str(const pet_json_t*j,int o,const char*k,char*s,size_t n){return pet_json_string(j,pet_json_field(j,o,k),s,n);}
static bool num(const pet_json_t*j,int o,const char*k,uint32_t*n){return pet_json_uint(j,pet_json_field(j,o,k),n);}
const char *pet_state_name(pet_state_t s){static const char*names[]={"unknown","queued","running","waiting_user","completed","failed","cancelled"};return names[s<=PET_CANCELLED?s:0];}
static bool task(const pet_json_t*j,int o,pet_task_t*t){
    memset(t,0,sizeof(*t));char state[24],execution[24],outcome[24];
    if(!str(j,o,"id",t->id,sizeof(t->id))||!t->id[0]||!str(j,o,"title",t->title,sizeof(t->title))||!str(j,o,"state",state,sizeof(state))||!str(j,o,"execution_state",execution,sizeof(execution)))return false;
    for(int i=0;i<=PET_CANCELLED;i++)if(!strcmp(state,pet_state_name(i)))t->state=i;
    int revision=pet_json_field(j,o,"state_revision");if(revision>=0&&!pet_json_uint64(j,revision,&t->state_revision))return false;
    int actions=pet_json_field(j,o,"available_actions");
    if(actions>=0){if(j->t[actions].kind!='[')return false;unsigned count=0;for(int i=actions+1;i<j->t[actions].next;i=j->t[i].next){char name[33];if(++count>4||!pet_json_string(j,i,name,sizeof(name)))return false;if(revision>=0&&!strcmp(name,"open_on_host"))t->can_open_host=true;}}
    t->running=!strcmp(execution,"running");int a=pet_json_field(j,o,"pending_interactions");
    if(a>=0){if(j->t[a].kind!='[')return false;unsigned count=0;for(int i=a+1;i<j->t[a].next;i=j->t[i].next){char request[97];uint32_t revision;bool blocks;if(++count>4||!str(j,i,"request_id",request,sizeof(request))||!request[0]||!num(j,i,"revision",&revision)||!pet_json_bool(j,pet_json_field(j,i,"blocks_execution"),&blocks))return false;}t->waiting=count>0;}
    t->goal_completed=str(j,o,"task_outcome",outcome,sizeof(outcome))&&!strcmp(outcome,"completed");return true;
}
void pet_model_init(pet_model_t*m,const char*epoch){memset(m,0,sizeof(*m));if(epoch)strncpy(m->view_epoch,epoch,64);}
void pet_model_privacy(pet_model_t*m,bool pub,const char*epoch){pet_model_init(m,epoch);m->public_mode=pub;m->needs_resync=true;}
void pet_model_tick(pet_model_t*m,uint32_t now){if(m->synchronizing&&now-m->stage_started_ms>10000){memset(&m->staging,0,sizeof(m->staging));m->synchronizing=false;m->needs_resync=true;}if(m->current.valid&&now-m->last_frame_ms>=45000){m->current.source_fresh=false;m->needs_resync=true;}}
static bool usage(const pet_json_t*j,int p,pet_view_t*v){int u=pet_json_field(j,p,"usage");if(u<0)return true;int t=pet_json_field(j,u,"tokens");v->usage_known=!(t>=0&&j->t[t].kind=='n'&&pet_json_is(j,t,"null"));if(v->usage_known){if(!pet_json_string(j,t,v->tokens,sizeof(v->tokens))||!v->tokens[0])return false;for(char*s=v->tokens;*s;s++)if(*s<'0'||*s>'9')return false;}else v->tokens[0]=0;int pr=pet_json_field(j,u,"provenance");return pr<0||pet_json_string(j,pr,v->provenance,sizeof(v->provenance));}
static bool page(const pet_json_t*j,int p,pet_view_t*v){
    int a=pet_json_field(j,p,"tasks");if(a>=0){if(j->t[a].kind!='[')return false;unsigned added=0;for(int i=a+1;i<j->t[a].next;i=j->t[i].next){if(++added>4||v->task_count>=PET_TASK_MAX)return false;pet_task_t t;if(!task(j,i,&t))return false;for(int k=0;k<v->task_count;k++)if(!strcmp(v->tasks[k].id,t.id))return false;v->tasks[v->task_count++]=t;}}
    a=pet_json_field(j,p,"inbox");if(a>=0){if(j->t[a].kind!='[')return false;for(int i=a+1;i<j->t[a].next;i=j->t[i].next){if(v->inbox_count>=PET_INBOX_MAX||!str(j,i,"title",v->inbox[v->inbox_count],PET_TEXT_MAX+1))return false;v->inbox_count++;}}
    a=pet_json_field(j,p,"source");if(a>=0){if(!pet_json_bool(j,pet_json_field(j,a,"connected"),&v->source_connected)||!pet_json_bool(j,pet_json_field(j,a,"fresh"),&v->source_fresh))return false;}
    uint32_t total;if(num(j,p,"total_tasks",&total))v->total_tasks=total;
    return usage(j,p,v);
}
pet_result_t pet_model_ingest(pet_model_t*m,const char*s,size_t len,uint32_t now){
    pet_json_t j;char type[32],stream[65],epoch[65],id[65];uint32_t rev,v;
    pet_model_tick(m,now);
    if(!pet_json_parse(&j,s,len)||!num(&j,0,"v",&v)||v!=1||!str(&j,0,"type",type,sizeof(type)))return PET_REJECTED;
    int p=pet_json_field(&j,0,"payload");if(p<0||j.t[p].kind!='{'||!str(&j,0,"stream_id",stream,sizeof(stream))||!str(&j,0,"view_epoch",epoch,sizeof(epoch))||!num(&j,0,"revision",&rev))return PET_REJECTED;
    if(strcmp(epoch,m->view_epoch))return PET_IGNORED;
    /* Known controls are outside the publication sequence. They cannot reset a
     * baseline or invalidate an in-progress snapshot when their stream differs. */
    if(!strcmp(type,"welcome"))return PET_WELCOME;
    if(!strcmp(type,"view.ready"))return PET_IGNORED;
    if(!strcmp(type,"action.offer")||!strcmp(type,"action.result"))return PET_ACTION_CONTROL;
    if(strcmp(type,"snapshot.begin")&&strcmp(type,"snapshot.page")&&strcmp(type,"snapshot.end")&&strcmp(type,"heartbeat")&&strcmp(type,"state.delta"))return PET_REJECTED;
    if(!strcmp(type,"snapshot.begin")){
        if(m->current.valid&&!strcmp(stream,m->current.stream)&&rev<m->current.revision)return PET_IGNORED;
        uint32_t pages,tasks,inbox;if(!str(&j,p,"snapshot_id",id,sizeof(id))||!num(&j,p,"page_count",&pages)||pages<1||pages>32||!num(&j,p,"task_count",&tasks)||tasks>PET_TASK_MAX||!num(&j,p,"inbox_count",&inbox)||inbox>PET_INBOX_MAX)return PET_REJECTED;
        if(m->public_mode&&(tasks||inbox))return PET_REJECTED;
        memset(&m->staging,0,sizeof(m->staging));strcpy(m->staging.stream,stream);m->staging.revision=rev;strcpy(m->snapshot_id,id);m->expected_pages=pages;m->expected_tasks=tasks;m->expected_inbox=inbox;m->next_page=0;m->synchronizing=true;m->stage_started_ms=now;m->needs_resync=false;return PET_APPLIED;
    }
    if(!strcmp(type,"snapshot.page")||!strcmp(type,"snapshot.end")){
        if(!m->synchronizing||strcmp(stream,m->staging.stream)||rev!=m->staging.revision||!str(&j,p,"snapshot_id",id,sizeof(id))||strcmp(id,m->snapshot_id))goto resync;
        if(!strcmp(type,"snapshot.page")){uint32_t n;if(!num(&j,p,"page",&n)||n!=m->next_page||n>=m->expected_pages||!page(&j,p,&m->staging))goto resync;if(m->public_mode&&(m->staging.task_count||m->staging.inbox_count||m->staging.usage_known)){goto resync;}m->next_page++;return PET_APPLIED;}
        if(m->next_page!=m->expected_pages||m->staging.task_count!=m->expected_tasks||m->staging.inbox_count!=m->expected_inbox)goto resync;
        m->staging.valid=true;m->current=m->staging;memset(&m->staging,0,sizeof(m->staging));m->synchronizing=false;m->last_frame_ms=now;return PET_APPLIED;
    }
    if(!m->current.valid&&!strcmp(type,"heartbeat")){
        int src=pet_json_field(&j,p,"source");bool connected=false,fresh=false;
        if(src>=0&&(!pet_json_bool(&j,pet_json_field(&j,src,"connected"),&connected)||!pet_json_bool(&j,pet_json_field(&j,src,"fresh"),&fresh)))return PET_REJECTED;
        m->current.source_connected=connected;m->current.source_fresh=false;m->last_frame_ms=now;return PET_APPLIED;
    }
    if(!m->current.valid||strcmp(stream,m->current.stream))goto resync;
    if(!strcmp(type,"heartbeat")){if(rev!=m->current.revision)goto resync;int src=pet_json_field(&j,p,"source");if(src>=0){bool connected,fresh;if(!pet_json_bool(&j,pet_json_field(&j,src,"connected"),&connected)||!pet_json_bool(&j,pet_json_field(&j,src,"fresh"),&fresh))return PET_REJECTED;m->current.source_connected=connected;m->current.source_fresh=fresh;}m->last_frame_ms=now;return PET_APPLIED;}
    if(strcmp(type,"state.delta"))return PET_IGNORED;
    if(rev<=m->current.revision)return PET_IGNORED;
    if(m->synchronizing||rev!=m->current.revision+1)goto resync;
    m->staging=m->current;int ops=pet_json_field(&j,p,"ops");if(ops<0||j.t[ops].kind!='[')goto resync;
    for(int i=ops+1;i<j.t[ops].next;i=j.t[i].next){char op[24];if(!str(&j,i,"op",op,sizeof(op)))goto resync;
        if(!strcmp(op,"usage.replace")){if(!usage(&j,i,&m->staging))goto resync;continue;}
        pet_task_t t;char tid[PET_ID_MAX+1];if(!strcmp(op,"task.upsert")){if(!task(&j,pet_json_field(&j,i,"task"),&t))goto resync;strcpy(tid,t.id);}else if(!strcmp(op,"task.remove")){if(!str(&j,i,"id",tid,sizeof(tid)))goto resync;}else goto resync;
        int k=0;while(k<m->staging.task_count&&strcmp(m->staging.tasks[k].id,tid))k++;
        if(!strcmp(op,"task.remove")){if(k<m->staging.task_count){memmove(&m->staging.tasks[k],&m->staging.tasks[k+1],(m->staging.task_count-k-1)*sizeof(t));m->staging.task_count--;}}
        else{if(k>=PET_TASK_MAX)goto resync;m->staging.tasks[k]=t;if(k==m->staging.task_count)m->staging.task_count++;}
    }
    if(m->public_mode&&(m->staging.task_count||m->staging.inbox_count||m->staging.usage_known))goto resync;
    m->staging.revision=rev;m->current=m->staging;memset(&m->staging,0,sizeof(m->staging));m->last_frame_ms=now;return PET_APPLIED;
resync: memset(&m->staging,0,sizeof(m->staging));m->synchronizing=false;m->needs_resync=true;m->current.source_fresh=false;return PET_RESYNC;
}
