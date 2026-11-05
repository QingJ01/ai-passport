#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define PET_FRAME_MAX 4096
#define PET_SAFE_INTEGER_MAX UINT64_C(9007199254740991)
#define PET_TASK_MAX 16
#define PET_INBOX_MAX 8
#define PET_TEXT_MAX 96
#define PET_ID_MAX 96

typedef enum { PET_UNKNOWN, PET_QUEUED, PET_RUNNING, PET_WAITING, PET_COMPLETED, PET_FAILED, PET_CANCELLED } pet_state_t;
typedef struct {
    char id[PET_ID_MAX + 1], title[PET_TEXT_MAX + 1];
    pet_state_t state;
    uint64_t state_revision;
    bool running, waiting, goal_completed, can_open_host;
} pet_task_t;
typedef struct {
    pet_task_t tasks[PET_TASK_MAX];
    char inbox[PET_INBOX_MAX][PET_TEXT_MAX + 1];
    char tokens[24], provenance[32];
    uint8_t task_count, inbox_count;
    uint32_t total_tasks, revision;
    char stream[65];
    bool source_connected, source_fresh, usage_known, valid;
} pet_view_t;
typedef struct {
    pet_view_t current, staging;
    char view_epoch[65], snapshot_id[65];
    uint32_t stage_started_ms, last_frame_ms;
    uint8_t expected_pages, next_page, expected_tasks, expected_inbox;
    bool synchronizing, public_mode, needs_resync;
} pet_model_t;
typedef enum { PET_APPLIED, PET_IGNORED, PET_REJECTED, PET_RESYNC, PET_WELCOME, PET_ACTION_CONTROL } pet_result_t;
void pet_model_init(pet_model_t *m, const char *epoch);
void pet_model_privacy(pet_model_t *m, bool public_mode, const char *new_epoch);
pet_result_t pet_model_ingest(pet_model_t *m, const char *json, size_t len, uint32_t now_ms);
void pet_model_tick(pet_model_t *m, uint32_t now_ms);
const char *pet_state_name(pet_state_t state);
/* Strict bounded JSON access shared by setup; parser workspace under 8 KB. */
typedef struct { int16_t start, end, next; uint8_t kind; } pet_json_token_t;
typedef struct { const char *text; pet_json_token_t t[768]; int count; } pet_json_t;
bool pet_json_parse(pet_json_t *j, const char *text, size_t len);
int pet_json_field(const pet_json_t *j, int object, const char *name);
bool pet_json_string(const pet_json_t *j, int token, char *out, size_t cap);
bool pet_json_pem_string(const pet_json_t *j, int token, char *out, size_t cap);
bool pet_json_uint64(const pet_json_t *j, int token, uint64_t *out);
bool pet_json_uint(const pet_json_t *j, int token, uint32_t *out);
bool pet_json_bool(const pet_json_t *j, int token, bool *out);
bool pet_json_is(const pet_json_t *j, int token, const char *value);
