#pragma once
#include <stdbool.h>
typedef struct { int active; bool held, initialized; } pet_input_t;
typedef enum { PET_KEY_PRESS, PET_KEY_RELEASE, PET_KEY_HOLD } pet_key_phase_t;
typedef enum { PET_KEY_NONE, PET_KEY_CLICK, PET_KEY_LONG } pet_key_action_t;
/* Single ADC ladder: changing keys mid-press cancels the entire gesture. */
pet_key_action_t pet_input_reduce(pet_input_t *state,int button,pet_key_phase_t phase);
typedef struct { unsigned page; bool menu, details, content_detail; } pet_navigation_t;
typedef enum { PET_NAV_UP, PET_NAV_DOWN, PET_NAV_OK_HOLD } pet_nav_event_t;
/* Menu/confirmation selection and detail scrolling are handled by their owners. */
void pet_navigation_reduce(pet_navigation_t *state, pet_nav_event_t event);
