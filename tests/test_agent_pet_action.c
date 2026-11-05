#include "agent_pet_action.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static const char boot[]="0123456789abcdef" "0123456789abcdef";
static const char identity[]="abcdef0123456789" "abcdef0123456789";
static char packet[4097],encoded[800],token[44];
static const uint64_t revision=UINT64_C(1800000000000001);
static bool offer(pet_action_t*a,uint64_t rev,uint32_t now,uint64_t utc){
    int n=snprintf(packet,sizeof(packet),"{\"v\":1,\"type\":\"action.offer\",\"stream_id\":\"s\",\"view_epoch\":\"e\",\"revision\":10,\"payload\":{\"type\":\"open_on_host\",\"target_id\":\"task:a\",\"target_revision\":%llu,\"token\":\"%s\",\"expires_at\":\"2030-01-01T00:00:30.000Z\"}}",(unsigned long long)rev,token);
    return pet_action_ingest(a,packet,(size_t)n,"e","s",now,utc);
}
static bool result(pet_action_t*a,const char*status,const char*id){
    int n=snprintf(packet,sizeof(packet),"{\"v\":1,\"type\":\"action.result\",\"stream_id\":\"s\",\"view_epoch\":\"e\",\"revision\":10,\"payload\":{\"action_id\":\"%s\",\"status\":\"%s\"}}",id,status);
    return pet_action_ingest(a,packet,(size_t)n,"e","s",400,0);
}
static bool number(const char*literal,uint64_t*out){pet_json_t j;char text[80];int n=snprintf(text,sizeof(text),"{\"r\":%s}",literal);return pet_json_parse(&j,text,(size_t)n)&&pet_json_uint64(&j,pet_json_field(&j,0,"r"),out);}
int main(void){
    memset(token,'t',43);token[43]=0;pet_action_t a;pet_action_init(&a,boot);
    assert(pet_action_begin(&a,"task:a",revision,identity,100));assert(a.phase==PET_ACTION_PREPARING);
    assert(pet_action_compose(&a,PET_ACTION_PREPARE_COMMAND,"e",encoded,sizeof(encoded))>0);assert(strstr(encoded,"action.prepare"));
    assert(!offer(&a,revision+1,200,0)&&a.phase==PET_ACTION_PREPARING);
    assert(offer(&a,revision,200,0)&&a.phase==PET_ACTION_READY&&a.deadline_ms==10200);
    assert(!pet_action_confirm(&a,revision+1,300)&&a.phase==PET_ACTION_CONFLICT&&!a.token[0]);
    assert(pet_action_begin(&a,"task:a",revision,identity,100));assert(offer(&a,revision,200,0));
    assert(pet_action_confirm(&a,revision,300)&&a.phase==PET_ACTION_SENT);
    int size=pet_action_compose(&a,PET_ACTION_EXECUTE_COMMAND,"e",encoded,sizeof(encoded));assert(size>0);
    pet_json_t j;uint64_t value;assert(pet_json_parse(&j,encoded,(size_t)size));int p=pet_json_field(&j,0,"payload");assert(pet_json_uint64(&j,pet_json_field(&j,p,"target_revision"),&value)&&value==revision);
    assert(!result(&a,"succeeded",boot)&&a.phase==PET_ACTION_SENT);
    assert(result(&a,"accepted",identity)&&a.phase==PET_ACTION_ACCEPTED);assert(strcmp(pet_action_status(a.phase),"Opened in host view"));
    assert(pet_action_compose(&a,PET_ACTION_EXECUTE_COMMAND,"e",encoded,sizeof(encoded))<0); /* no resend */
    assert(result(&a,"unknown",identity)&&a.phase==PET_ACTION_UNKNOWN);
    assert(!pet_action_begin(&a,"task:b",revision,identity,500));
    assert(pet_action_compose(&a,PET_ACTION_QUERY_COMMAND,"e",encoded,sizeof(encoded))>0);assert(strstr(encoded,identity)&&strstr(encoded,"action.query"));
    pet_action_hide_private(&a);assert(!a.target_id[0]&&!a.token[0]&&a.phase==PET_ACTION_UNKNOWN);assert(!strcmp(a.action_id,identity));
    assert(result(&a,"succeeded",identity)&&a.phase==PET_ACTION_SUCCEEDED);assert(!strcmp(pet_action_status(a.phase),"Opened in host view"));
    assert(!result(&a,"accepted",identity)&&a.phase==PET_ACTION_SUCCEEDED);
    assert(pet_action_begin(&a,"task:a",revision,identity,100));assert(offer(&a,revision,200,UINT64_C(1893456000000)));assert(a.deadline_ms==25200);
    pet_action_tick(&a,25200);assert(a.phase==PET_ACTION_EXPIRED&&!a.token[0]);
    assert(pet_action_begin(&a,"task:a",revision,identity,100));assert(offer(&a,revision,200,UINT64_C(1893456030000)));assert(a.phase==PET_ACTION_EXPIRED);
    assert(pet_action_begin(&a,"task:a",revision,identity,100));assert(offer(&a,revision,200,0));pet_action_tick(&a,10200);assert(!pet_action_confirm(&a,revision,10200));
    pet_action_init(&a,boot);assert(!pet_action_begin(&a,"task:a",PET_JS_SAFE_MAX+1,identity,100));assert(pet_action_begin(&a,"task:a",PET_JS_SAFE_MAX,identity,100));
    assert(number("9007199254740991",&value)&&value==PET_JS_SAFE_MAX);
    assert(!number("9007199254740992",&value));
    assert(!number("\"1800000000000001\"",&value));
    assert(!number("1.5",&value));
    pet_action_init(&a,boot);assert(pet_action_begin(&a,"task:a",revision,identity,UINT32_MAX-200));assert(offer(&a,revision,UINT32_MAX-100,0));pet_action_tick(&a,9900);assert(a.phase==PET_ACTION_EXPIRED);
    pet_action_init(&a,boot);assert(pet_action_begin(&a,"task:\"quoted",revision,identity,100));assert(pet_action_compose(&a,PET_ACTION_PREPARE_COMMAND,"e",encoded,sizeof(encoded))>0);assert(pet_json_parse(&j,encoded,strlen(encoded)));
    FILE *frames=fopen("tests/fixtures/agent-pet-action-frames.jsonl","rb");assert(frames);
    static char line[3][1024];int count=0;
    while(count<3&&fgets(line[count],sizeof(line[count]),frames)){size_t len=strlen(line[count]);if(len&&line[count][len-1]=='\n')line[count][len-1]=0;count++;}
    fclose(frames);assert(count==3);
    pet_action_init(&a,"00112233445566778899aabbccddeeff");
    assert(pet_action_begin(&a,"fixture-task",UINT64_C(1762300000123),"ffeeddccbbaa99887766554433221100",1000));
    assert(pet_action_compose(&a,PET_ACTION_PREPARE_COMMAND,"fixture-epoch",encoded,sizeof(encoded))>0);
    assert(!strcmp(encoded,line[0]));
    pet_action_init(&a,"00112233445566778899aabbccddeeff");
    assert(pet_action_begin(&a,"fixture-task",UINT64_C(1762300000123),"ffeeddccbbaa99887766554433221100",1000));
    const char *fixture_offer="{\"v\":1,\"type\":\"action.offer\",\"stream_id\":\"fixture-stream\",\"view_epoch\":\"fixture-epoch\",\"revision\":3,\"payload\":{\"token\":\"fixturetoken0000000000000000000000000000000000\",\"type\":\"open_on_host\",\"target_id\":\"fixture-task\",\"target_revision\":1762300000123,\"expires_at\":\"2030-01-01T00:00:00.000Z\"}}";
    assert(pet_action_ingest(&a,fixture_offer,strlen(fixture_offer),"fixture-epoch","fixture-stream",1500,0));
    assert(pet_action_confirm(&a,UINT64_C(1762300000123),1600));
    assert(pet_action_compose(&a,PET_ACTION_EXECUTE_COMMAND,"fixture-epoch",encoded,sizeof(encoded))>0);
    assert(!strcmp(encoded,line[1]));
    assert(pet_action_compose(&a,PET_ACTION_QUERY_COMMAND,"fixture-epoch",encoded,sizeof(encoded))>0);
    assert(!strcmp(encoded,line[2]));
    assert(sizeof(pet_action_t)<=384);printf("Agent Pet bounded host action tests passed (%zu-byte descriptor)\n",sizeof(pet_action_t));return 0;
}
