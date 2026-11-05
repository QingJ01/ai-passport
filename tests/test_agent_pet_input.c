#include "agent_pet_input.h"
#include <assert.h>
#include <stdio.h>
int main(void){
    pet_input_t s={0};
    assert(pet_input_reduce(&s,2,PET_KEY_RELEASE)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,2,PET_KEY_PRESS)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,2,PET_KEY_RELEASE)==PET_KEY_CLICK);
    assert(pet_input_reduce(&s,2,PET_KEY_PRESS)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,2,PET_KEY_RELEASE)==PET_KEY_CLICK);
    assert(pet_input_reduce(&s,2,PET_KEY_PRESS)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,2,PET_KEY_HOLD)==PET_KEY_LONG);
    assert(pet_input_reduce(&s,2,PET_KEY_HOLD)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,2,PET_KEY_RELEASE)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,0,PET_KEY_PRESS)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,1,PET_KEY_PRESS)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,1,PET_KEY_RELEASE)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,0,PET_KEY_RELEASE)==PET_KEY_NONE);
    /* A wake-held key never enters this reducer until the guard sees release. */
    s=(pet_input_t){0};assert(pet_input_reduce(&s,2,PET_KEY_RELEASE)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,0,PET_KEY_PRESS)==PET_KEY_NONE);
    assert(pet_input_reduce(&s,0,PET_KEY_RELEASE)==PET_KEY_CLICK);
    pet_navigation_t nav={.page=1,.details=true};
    pet_navigation_reduce(&nav,PET_NAV_DOWN);assert(nav.page==2&&!nav.details);
    nav=(pet_navigation_t){.page=0,.details=true};
    pet_navigation_reduce(&nav,PET_NAV_UP);assert(nav.page==3&&!nav.details);
    pet_navigation_reduce(&nav,PET_NAV_DOWN);assert(nav.page==0);
    nav.details=true;pet_navigation_reduce(&nav,PET_NAV_OK_HOLD);assert(nav.menu&&!nav.details);
    pet_navigation_reduce(&nav,PET_NAV_OK_HOLD);assert(!nav.menu);
    nav.content_detail=true;nav.details=true;
    pet_navigation_reduce(&nav,PET_NAV_DOWN);assert(nav.page==0&&nav.content_detail);
    pet_navigation_reduce(&nav,PET_NAV_OK_HOLD);assert(!nav.content_detail&&!nav.menu&&!nav.details);
    pet_navigation_reduce(&nav,PET_NAV_OK_HOLD);assert(nav.menu);
    pet_navigation_reduce(&nav,PET_NAV_UP);assert(nav.page==0&&nav.menu);
    puts("Agent Pet immediate button and visible navigation semantics passed");return 0;
}
