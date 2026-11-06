#include "agent_pet_mood.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static pet_task_t task(const char *id,const char *title,bool running,bool waiting){
    pet_task_t t={0};snprintf(t.id,sizeof(t.id),"%s",id);snprintf(t.title,sizeof(t.title),"%s",title);
    t.running=running;t.waiting=waiting;t.state=waiting?PET_WAITING:running?PET_RUNNING:PET_UNKNOWN;return t;
}

int main(void){
    pet_mood_tracker_t tr={0};pet_view_t v={0};pet_event_t e;
    /* An invalid view never primes or reports. */
    assert(pet_mood_update(&tr,&v,0,&e)==PET_MOOD_IDLE&&e.kind==PET_EVENT_NONE&&!tr.primed);
    /* The first valid view primes only: already-finished tasks are not replayed. */
    v.valid=true;v.task_count=2;v.tasks[0]=task("a","重构设置页面",true,false);v.tasks[1]=task("b","网站",false,false);
    assert(pet_mood_update(&tr,&v,100,&e)==PET_MOOD_WORK&&e.kind==PET_EVENT_NONE&&tr.primed);
    /* Running -> stopped is a completion with a short celebration. */
    v.tasks[0].running=false;
    assert(pet_mood_update(&tr,&v,200,&e)==PET_MOOD_CELEBRATE&&e.kind==PET_EVENT_DONE&&!strcmp(e.title,"重构设置页面"));
    assert(pet_mood_update(&tr,&v,200+PET_CELEBRATE_MS-1,&e)==PET_MOOD_CELEBRATE&&e.kind==PET_EVENT_NONE);
    assert(pet_mood_update(&tr,&v,200+PET_CELEBRATE_MS,&e)==PET_MOOD_IDLE);
    /* A new question outranks everything and is reported once. */
    v.tasks[1].waiting=true;
    assert(pet_mood_update(&tr,&v,5000,&e)==PET_MOOD_ALERT&&e.kind==PET_EVENT_ASK&&!strcmp(e.title,"网站"));
    assert(pet_mood_update(&tr,&v,5100,&e)==PET_MOOD_ALERT&&e.kind==PET_EVENT_NONE);
    /* Running -> waiting is a question, not a completion. */
    pet_mood_tracker_t t2={0};pet_view_t w={0};w.valid=true;w.task_count=1;w.tasks[0]=task("x","Build",true,false);
    pet_mood_update(&t2,&w,0,&e);w.tasks[0].running=false;w.tasks[0].waiting=true;
    assert(pet_mood_update(&t2,&w,10,&e)==PET_MOOD_ALERT&&e.kind==PET_EVENT_ASK&&t2.celebrate_until==0);
    /* A task that disappears is not reported as done; a new task is not an event. */
    w.task_count=1;w.tasks[0]=task("y","New",true,false);
    assert(pet_mood_update(&t2,&w,20,&e)==PET_MOOD_WORK&&e.kind==PET_EVENT_NONE);
    /* Clock wrap keeps the celebration window correct. */
    pet_mood_tracker_t t3={0};pet_view_t z={0};z.valid=true;z.task_count=1;z.tasks[0]=task("z","Wrap",true,false);
    pet_mood_update(&t3,&z,UINT32_MAX-100,&e);z.tasks[0].running=false;
    assert(pet_mood_update(&t3,&z,UINT32_MAX-50,&e)==PET_MOOD_CELEBRATE);
    assert(pet_mood_update(&t3,&z,1000,&e)==PET_MOOD_CELEBRATE);
    assert(pet_mood_update(&t3,&z,PET_CELEBRATE_MS,&e)==PET_MOOD_IDLE);
    /* Idle long enough dozes off; any activity wakes it. */
    pet_mood_tracker_t t4={0};pet_view_t s={0};s.valid=true;s.task_count=1;s.tasks[0]=task("s","Sleepy",false,false);
    assert(pet_mood_update(&t4,&s,1000,&e)==PET_MOOD_IDLE);
    assert(pet_mood_update(&t4,&s,1000+PET_SLEEP_MS-1,&e)==PET_MOOD_IDLE);
    assert(pet_mood_update(&t4,&s,1000+PET_SLEEP_MS,&e)==PET_MOOD_SLEEP);
    s.tasks[0].running=true;assert(pet_mood_update(&t4,&s,200000,&e)==PET_MOOD_WORK&&!t4.idle);
    s.tasks[0].running=false;assert(pet_mood_update(&t4,&s,200001,&e)==PET_MOOD_CELEBRATE);
    assert(pet_mood_update(&t4,&s,200001+PET_CELEBRATE_MS,&e)==PET_MOOD_IDLE);
    assert(pet_mood_intensity("")==0&&pet_mood_intensity("12.5")==1&&pet_mood_intensity("77.9")==4);
    assert(pet_mood_intensity("195")==10&&pet_mood_intensity("5000")==10&&pet_mood_intensity("x")==0);
    assert(!pet_desk_due(19999,0,false,0)&&pet_desk_due(20000,0,false,0));
    assert(!pet_desk_due(30000,0,true,0)&&!pet_desk_due(30000,0,false,1));
    assert(pet_desk_due(5,UINT32_MAX-PET_DESK_IDLE_MS+5,false,0));
    puts("Agent Pet mood/event tests: PASS");
    return 0;
}
