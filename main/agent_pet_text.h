#pragma once
/* Simplified Chinese copy for the Agent Pet screen. Pure C, no LVGL, so the
 * translation tables and formatting are covered by host tests. Every string
 * returned here must be drawable by the UI subset fonts (see agent_pet_font.py). */
#include <stdbool.h>
#include <stddef.h>
#include "agent_pet_action.h"

/* Translate a runtime status line. Unknown inputs return a neutral fallback,
 * never the English source, so the screen stays in one language. */
const char *pet_text_status(const char *runtime_status, bool fresh, bool remote);
/* True when the runtime status is in the translation table. */
bool pet_text_status_known(const char *runtime_status);
/* Short state label for one task, e.g. "进行中" or "等你回复". */
const char *pet_text_task_state(const pet_task_t *task);
const char *pet_text_action_title(pet_action_phase_t phase);
/* Known bridge provenance tokens; NULL when the caller must show the raw value. */
const char *pet_text_provenance(const char *provenance);
/* Known bridge inbox titles; returns the input unchanged when unknown. */
const char *pet_text_inbox(const char *title);
/* "1234567" -> "1,234,567". Non-digit input is copied unchanged. */
void pet_text_group_digits(const char *digits, char *out, size_t capacity);
