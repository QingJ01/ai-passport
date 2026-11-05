#include "agent_pet_text.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void){
    char out[40];
    pet_text_group_digits("184206",out,sizeof(out));assert(!strcmp(out,"184,206"));
    pet_text_group_digits("1234567",out,sizeof(out));assert(!strcmp(out,"1,234,567"));
    pet_text_group_digits("999",out,sizeof(out));assert(!strcmp(out,"999"));
    pet_text_group_digits("",out,sizeof(out));assert(!strcmp(out,""));
    pet_text_group_digits("12a",out,sizeof(out));assert(!strcmp(out,"12a"));
    pet_text_group_digits("1234567",out,6);assert(strlen(out)<6);
    pet_text_group_digits("99999999999999999999999",out,sizeof(out));assert(!strcmp(out,"99,999,999,999,999,999,999,999"));
    assert(!strcmp(pet_text_status("Service synchronized",true,false),"电脑实时同步"));
    assert(!strcmp(pet_text_status("Service synchronized",true,true),"中继实时同步"));
    assert(!strcmp(pet_text_status("Service synchronized",false,false),"显示上次收到的数据"));
    assert(!strcmp(pet_text_status("USB setup required",false,false),"等待连接"));
    assert(!strcmp(pet_text_status("never seen",false,false),"状态未知"));
    assert(!strcmp(pet_text_status(NULL,false,false),"状态未知"));
    assert(pet_text_status_known("Wi-Fi ready; connecting service")&&!pet_text_status_known("never seen"));
    pet_task_t t={0};
    assert(!strcmp(pet_text_task_state(&t),"空闲"));
    t.running=true;assert(!strcmp(pet_text_task_state(&t),"进行中"));
    t.waiting=true;assert(!strcmp(pet_text_task_state(&t),"进行中，等你回复"));
    t=(pet_task_t){.state=PET_FAILED};assert(!strcmp(pet_text_task_state(&t),"失败"));
    t=(pet_task_t){.state=PET_COMPLETED};assert(!strcmp(pet_text_task_state(&t),"已完成"));
    assert(!strcmp(pet_text_action_title(PET_ACTION_READY),"在电脑上打开？"));
    assert(!strcmp(pet_text_action_title((pet_action_phase_t)99),"在电脑上打开"));
    assert(!strcmp(pet_text_provenance("host-reduced-records"),"电脑端汇总"));
    assert(!strcmp(pet_text_provenance(""),"暂无来源"));
    assert(pet_text_provenance("Magpie desktop")==NULL);
    assert(!strcmp(pet_text_inbox("Input requested"),"有任务在等你回复"));
    assert(!strcmp(pet_text_inbox("自定义提醒"),"自定义提醒"));
    puts("Agent Pet Chinese text tests: PASS");
    return 0;
}
