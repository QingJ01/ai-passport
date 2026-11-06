#pragma once
#include "agent_pet_config.h"
#include "agent_pet_action.h"
#include "esp_err.h"
typedef struct { pet_view_t current; bool public_mode; pet_transport_t transport; } pet_runtime_view_t;
void pet_runtime_phase(const char *phase);
void pet_runtime_pause_business(bool pause);
bool pet_runtime_business_stopped(void);
void pet_runtime_provision_failed(void);
void pet_runtime_start(void);
void pet_runtime_ui_state(uint32_t keys_seen,unsigned page,bool menu,bool details);
void pet_runtime_copy(pet_runtime_view_t *out,char *status,size_t capacity);
bool pet_runtime_open_prepare(const char *task_id);
bool pet_runtime_open_confirm(void);
void pet_runtime_open_cancel(void);
bool pet_runtime_open_query(void);
void pet_runtime_open_copy(pet_action_view_t *out);
void pet_runtime_privacy(bool public_mode);
void pet_runtime_setup_window(void);
/* A computer on USB asked to link (link.request) within the last few seconds
 * and no window is open: the UI shows a one-press consent prompt. */
bool pet_runtime_link_requested(void);
/* Decline: ignore further link requests for a minute. */
void pet_runtime_link_dismiss(void);
/* UI theme index persisted in NVS (0 = default). */
uint8_t pet_runtime_theme(void);
void pet_runtime_set_theme(uint8_t theme);
/* Seconds left in the physical USB window, 0 when it is closed. */
unsigned pet_runtime_setup_seconds(void);
void pet_runtime_confirm(void);
bool pet_runtime_setup_pending(void);
/* The Wi-Fi name inside a pending USB setup, for the confirmation screen. */
bool pet_runtime_setup_ssid(char *out,size_t capacity);
void pet_runtime_cancel_setup(void);
size_t pet_runtime_network_slots(char ssids[PET_NETWORK_MAX][33]);
bool pet_runtime_network_slot(char *ssid,size_t capacity);
typedef enum { PET_SETTINGS_FORGET_WIFI=1,PET_SETTINGS_UNPAIR=2,PET_SETTINGS_FACTORY_RESET=3,PET_SETTINGS_DISABLE_REMOTE=4 } pet_settings_action_t;
void pet_runtime_settings_action(pet_settings_action_t action);
/* Authenticated provisioning caller chooses the independent trust profile first.
 * Retargeting preserves a Wi-Fi candidate already received by the SDK. */
bool pet_runtime_setup_target(pet_transport_t target);
bool pet_runtime_select_transport(pet_transport_t target);
bool pet_runtime_network_candidate(const char *ssid,const char *key,int replace_slot);
bool pet_runtime_device_identity(const char *device_id);
bool pet_runtime_time_bootstrap(const char *url,const char *issuer,const char *public_key_pem);
bool pet_runtime_mobile_config(const char *endpoint,const char *token,const char *ca_pem,const char *server_name,uint32_t utc_seconds);
