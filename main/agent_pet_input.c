#include "agent_pet_input.h"
void pet_navigation_reduce(pet_navigation_t*s,pet_nav_event_t event){
    if(event==PET_NAV_OK_HOLD){
        if(s->content_detail)s->content_detail=false;
        else s->menu=!s->menu;
        s->details=false;
    }else if(!s->menu&&!s->content_detail){
        s->page=(s->page+(event==PET_NAV_UP?3u:1u))%4u;
        s->details=false;
    }
}
pet_key_action_t pet_input_reduce(pet_input_t*s,int b,pet_key_phase_t phase){
    if(!s->initialized){s->active=-1;s->held=false;s->initialized=true;}
    if(b<0||b>2)return PET_KEY_NONE;
    if(phase==PET_KEY_PRESS){
        if(s->active==-1){s->active=b;s->held=false;}
        else if(s->active!=b)s->active=-2;
        return PET_KEY_NONE;
    }
    if(s->active==-2){if(phase==PET_KEY_RELEASE)s->active=-1;return PET_KEY_NONE;}
    if(s->active!=b){if(s->active>=0)s->active=-2;return PET_KEY_NONE;}
    if(phase==PET_KEY_HOLD){if(s->held)return PET_KEY_NONE;s->held=true;return PET_KEY_LONG;}
    if(phase==PET_KEY_RELEASE){bool click=!s->held;s->active=-1;s->held=false;return click?PET_KEY_CLICK:PET_KEY_NONE;}
    return PET_KEY_NONE;
}
