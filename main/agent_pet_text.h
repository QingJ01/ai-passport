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
/* Compact count: "987" -> "987", "52340" -> "52.3K", "18817828" -> "18.8M", "1234567890" -> "1.2B". */
void pet_text_compact_count(const char *digits, char *out, size_t capacity);
/* Task metrics such as "5.2万 Token・38.5 t/s\n费用 约￥0.36"; empty when none. */
void pet_text_task_metrics(const pet_task_t *task, char *out, size_t capacity);
