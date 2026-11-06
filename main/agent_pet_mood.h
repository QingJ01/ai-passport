#pragma once
/* Pet mood, task events and desk-mode timing. Pure C (no LVGL/ESP-IDF) so the
 * behaviour is host-tested; the UI only maps the results to animation. */
#include <stdbool.h>
#include <stdint.h>
#include "agent_pet_model.h"

typedef enum { PET_MOOD_IDLE, PET_MOOD_WORK, PET_MOOD_ALERT, PET_MOOD_CELEBRATE, PET_MOOD_SLEEP } pet_mood_t;
typedef enum { PET_EVENT_NONE, PET_EVENT_DONE, PET_EVENT_ASK } pet_event_kind_t;
typedef struct { pet_event_kind_t kind; char title[PET_TEXT_MAX + 1]; } pet_event_t;

typedef struct {
    uint32_t ids[PET_TASK_MAX];
    bool running[PET_TASK_MAX], waiting[PET_TASK_MAX];
    uint8_t count;
    bool primed;
    uint32_t celebrate_until;
    uint32_t idle_since;
    bool idle;
} pet_mood_tracker_t;

#define PET_CELEBRATE_MS 2500u
#define PET_DESK_IDLE_MS 20000u
#define PET_SLEEP_MS 90000u  /* continuously idle this long: the pet dozes off */

/* Compare with the previous view and report at most one new event (asking for
 * input outranks a finished task). The first valid view only primes the
 * tracker, so reconnecting never replays old completions. */
pet_mood_t pet_mood_update(pet_mood_tracker_t *tracker, const pet_view_t *view, uint32_t now_ms, pet_event_t *event);
/* Particle intensity 0..10 from the live decode rate string ("77.9"). */
unsigned pet_mood_intensity(const char *rate);
/* Desk mode starts after PET_DESK_IDLE_MS without a key on the home page. */
bool pet_desk_due(uint32_t now_ms, uint32_t last_key_ms, bool modal, unsigned page);
