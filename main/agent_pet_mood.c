#include "agent_pet_mood.h"
#include <stdio.h>
#include <string.h>

static uint32_t fnv(const char *s){uint32_t h=2166136261u;for(;*s;s++){h^=(uint8_t)*s;h*=16777619u;}return h?h:1;}

pet_mood_t pet_mood_update(pet_mood_tracker_t *t,const pet_view_t *v,uint32_t now,pet_event_t *event){
    if(event){event->kind=PET_EVENT_NONE;event->title[0]=0;}
    if(!t||!v)return PET_MOOD_IDLE;
    bool running=false,waiting=false;
    for(unsigned i=0;i<v->task_count;i++){running|=v->tasks[i].running;waiting|=v->tasks[i].waiting;}
    if(v->valid){
        const pet_task_t *done=NULL,*ask=NULL;
        if(t->primed)for(unsigned i=0;i<v->task_count;i++){
            const pet_task_t *task=&v->tasks[i];uint32_t id=fnv(task->id);
            for(unsigned k=0;k<t->count;k++){
                if(t->ids[k]!=id)continue;
                if(!t->waiting[k]&&task->waiting&&!ask)ask=task;
                if(t->running[k]&&!task->running&&!task->waiting&&!done)done=task;
                break;
            }
        }
        t->count=v->task_count;
        for(unsigned i=0;i<v->task_count;i++){t->ids[i]=fnv(v->tasks[i].id);t->running[i]=v->tasks[i].running;t->waiting[i]=v->tasks[i].waiting;}
        t->primed=true;
        const pet_task_t *chosen=ask?ask:done;
        if(chosen&&event){event->kind=ask?PET_EVENT_ASK:PET_EVENT_DONE;snprintf(event->title,sizeof(event->title),"%s",chosen->title);}
        if(done&&!ask)t->celebrate_until=now+PET_CELEBRATE_MS;
    }
    pet_mood_t mood;
    if(waiting)mood=PET_MOOD_ALERT;
    else if(t->celebrate_until&&(int32_t)(t->celebrate_until-now)>0)mood=PET_MOOD_CELEBRATE;
    else{t->celebrate_until=0;mood=running?PET_MOOD_WORK:PET_MOOD_IDLE;}
    if(mood!=PET_MOOD_IDLE){t->idle=false;return mood;}
    if(!t->idle){t->idle=true;t->idle_since=now;}
    return now-t->idle_since>=PET_SLEEP_MS?PET_MOOD_SLEEP:PET_MOOD_IDLE;
}

unsigned pet_mood_intensity(const char *rate){
    if(!rate||!*rate)return 0;
    unsigned whole=0;
    for(const char *p=rate;*p&&*p!='.';p++){if(*p<'0'||*p>'9')return 0;if(whole<100000)whole=whole*10+(unsigned)(*p-'0');}
    /* ~20 t/s per step: 0 idle .. 10 at 200 t/s and above. */
    unsigned level=(whole+19)/20;
    return level>10?10:level;
}

bool pet_desk_due(uint32_t now,uint32_t last_key,bool modal,unsigned page){
    return !modal&&page==0&&now-last_key>=PET_DESK_IDLE_MS;
}
