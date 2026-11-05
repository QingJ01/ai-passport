#include "agent_pet_model.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static pet_model_t m;
static pet_result_t frame(const char *type,unsigned rev,const char *payload){char b[4097];int n=snprintf(b,sizeof(b),"{\"v\":1,\"type\":\"%s\",\"stream_id\":\"s\",\"view_epoch\":\"e\",\"revision\":%u,\"payload\":%s}",type,rev,payload);return pet_model_ingest(&m,b,(size_t)n,100);}
static void snapshot(void){assert(frame("snapshot.begin",4,"{\"snapshot_id\":\"x\",\"page_count\":1,\"task_count\":1,\"inbox_count\":0}")==PET_APPLIED);assert(m.synchronizing);assert(frame("snapshot.page",4,"{\"snapshot_id\":\"x\",\"page\":0,\"tasks\":[{\"id\":\"a\",\"title\":\"Working\",\"state_revision\":1800000000000001,\"available_actions\":[\"open_on_host\"],\"state\":\"waiting_user\",\"execution_state\":\"running\",\"pending_interactions\":[{\"request_id\":\"q\",\"revision\":1,\"blocks_execution\":false}]}],\"source\":{\"connected\":true,\"fresh\":true},\"usage\":{\"tokens\":null,\"provenance\":\"unknown\"}}")==PET_APPLIED);assert(m.synchronizing);assert(frame("snapshot.end",4,"{\"snapshot_id\":\"x\"}")==PET_APPLIED);}
int main(void){
    pet_model_init(&m,"e");
    const char *ready="{\"v\":1,\"type\":\"view.ready\",\"stream_id\":\"new-control-stream\",\"view_epoch\":\"e\",\"revision\":99,\"payload\":{\"mode\":\"private\"}}";
    pet_model_t before=m;assert(pet_model_ingest(&m,ready,strlen(ready),100)==PET_IGNORED);assert(!memcmp(&m,&before,sizeof(m)));
    assert(frame("snapshot.begin",4,"{\"snapshot_id\":\"x\",\"page_count\":1,\"task_count\":1,\"inbox_count\":0}")==PET_APPLIED);
    before=m;assert(pet_model_ingest(&m,ready,strlen(ready),100)==PET_IGNORED);assert(!memcmp(&m,&before,sizeof(m)));
    assert(frame("future.business",4,"{}")==PET_REJECTED);assert(!memcmp(&m,&before,sizeof(m)));
    snapshot();before=m;assert(pet_model_ingest(&m,ready,strlen(ready),100)==PET_IGNORED);assert(!memcmp(&m,&before,sizeof(m)));
    assert(frame("action.result",99,"{\"status\":\"accepted\"}")==PET_ACTION_CONTROL);assert(!memcmp(&m,&before,sizeof(m)));
    assert(m.current.valid&&m.current.tasks[0].running&&m.current.tasks[0].waiting);assert(!m.current.tasks[0].goal_completed&&!m.current.usage_known);assert(m.current.tasks[0].state_revision==UINT64_C(1800000000000001)&&m.current.tasks[0].can_open_host);
    assert(frame("state.delta",5,"{\"ops\":[{\"op\":\"usage.replace\",\"usage\":{\"tokens\":\"12345\",\"provenance\":\"host\"}}]}")==PET_APPLIED);assert(!strcmp(m.current.tokens,"12345"));
    assert(frame("state.delta",6,"{\"ops\":[{\"op\":\"usage.replace\",\"usage\":{\"tokens\":\"null\",\"provenance\":\"host\"}}]}")==PET_RESYNC);assert(m.current.revision==5&&m.current.usage_known&&!strcmp(m.current.tokens,"12345"));
    assert(frame("state.delta",5,"{\"ops\":[]}")==PET_IGNORED);
    assert(frame("state.delta",7,"{\"ops\":[]}")==PET_RESYNC);assert(m.current.revision==5&&m.needs_resync);
    pet_model_init(&m,"e");snapshot();assert(frame("state.delta",5,"{\"ops\":[{\"op\":\"task.remove\",\"id\":\"a\"},{\"op\":\"unsupported\"}]}")==PET_RESYNC);assert(m.current.task_count==1);
    assert(frame("snapshot.begin",9,"{\"snapshot_id\":\"x\",\"page_count\":1,\"task_count\":17,\"inbox_count\":0}")==PET_REJECTED);
    assert(frame("snapshot.begin",9,"{\"snapshot_id\":\"x\",\"page_count\":2,\"task_count\":0,\"inbox_count\":0}")==PET_APPLIED);assert(frame("snapshot.end",9,"{\"snapshot_id\":\"x\"}")==PET_RESYNC);assert(m.current.task_count==1);
    assert(frame("snapshot.begin",9,"{\"snapshot_id\":\"x\",\"page_count\":2,\"task_count\":0,\"inbox_count\":0}")==PET_APPLIED);pet_model_tick(&m,10101);assert(!m.synchronizing&&m.needs_resync);
    pet_model_privacy(&m,true,"new");before=m;assert(pet_model_ingest(&m,ready,strlen(ready),100)==PET_IGNORED);assert(!memcmp(&m,&before,sizeof(m)));assert(!m.current.valid&&!m.current.task_count&&!m.staging.task_count);assert(frame("snapshot.begin",1,"{}")==PET_IGNORED);pet_model_privacy(&m,false,"e");assert(!m.current.valid);snapshot();pet_model_tick(&m,45100);assert(!m.current.source_fresh);
    pet_json_t j;char out[32];const char *text="{\"text\":\"\\u4f60\\u597d\"}";assert(pet_json_parse(&j,text,strlen(text)));assert(pet_json_string(&j,pet_json_field(&j,0,"text"),out,sizeof(out)));assert(!strcmp(out,"你好"));
    text="{\"text\":\"\\u0000\"}";assert(pet_json_parse(&j,text,strlen(text)));assert(!pet_json_string(&j,pet_json_field(&j,0,"text"),out,sizeof(out)));
    text="{\"n\":4294967296}";uint32_t n;assert(pet_json_parse(&j,text,strlen(text)));assert(!pet_json_uint(&j,pet_json_field(&j,0,"n"),&n));
    text="{\"text\":\"x\",\"text\":\"y\"}";assert(!pet_json_parse(&j,text,strlen(text)));
    char huge[4097];memset(huge,' ',sizeof(huge));assert(!pet_json_parse(&j,huge,sizeof(huge)));
    assert(sizeof(pet_model_t)<40000);printf("Agent Pet state/protocol tests passed (%zu-byte model)\n",sizeof(pet_model_t));return 0;
}
