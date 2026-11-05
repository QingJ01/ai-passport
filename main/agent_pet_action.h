#pragma once
#include "agent_pet_model.h"
#define PET_JS_SAFE_MAX PET_SAFE_INTEGER_MAX
typedef enum { PET_ACTION_IDLE,PET_ACTION_PREPARING,PET_ACTION_READY,PET_ACTION_SENT,PET_ACTION_ACCEPTED,PET_ACTION_SUCCEEDED,PET_ACTION_FAILED,PET_ACTION_UNKNOWN,PET_ACTION_CONFLICT,PET_ACTION_EXPIRED } pet_action_phase_t;
typedef struct {
    char target_id[PET_ID_MAX+1],token[129],action_id[33],boot_id[33];
    uint64_t target_revision;
    uint32_t deadline_ms;
    pet_action_phase_t phase;
} pet_action_t;
typedef struct { pet_action_phase_t phase; char target_id[PET_ID_MAX+1],title[PET_TEXT_MAX+1]; bool can_confirm,can_query; } pet_action_view_t;
typedef enum { PET_ACTION_PREPARE_COMMAND,PET_ACTION_EXECUTE_COMMAND,PET_ACTION_QUERY_COMMAND } pet_action_command_t;
void pet_action_init(pet_action_t *action,const char *boot_id);
bool pet_action_begin(pet_action_t *action,const char *target_id,uint64_t revision,const char *action_id,uint32_t now_ms);
void pet_action_tick(pet_action_t *action,uint32_t now_ms);
void pet_action_hide_private(pet_action_t *action);
bool pet_action_confirm(pet_action_t *action,uint64_t current_revision,uint32_t now_ms);
bool pet_action_ingest(pet_action_t *action,const char *json,size_t length,const char *view_epoch,const char *stream_id,uint32_t now_ms,uint64_t utc_ms);
int pet_action_compose(const pet_action_t *action,pet_action_command_t command,const char *view_epoch,char *output,size_t capacity);
const char *pet_action_status(pet_action_phase_t phase);
