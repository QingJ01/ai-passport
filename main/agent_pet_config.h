#pragma once
#include "agent_pet_model.h"
#define PET_NETWORK_MAX 3
#define PET_CONFIG_VERSION 2u
typedef enum { PET_TRANSPORT_LOCAL=0, PET_TRANSPORT_REMOTE=1 } pet_transport_t;
typedef struct { char ssid[33], key[65]; } pet_network_t;
typedef struct {
    char endpoint[257], token[129], ca[2049], server[129], device_id[97];
    char time_url[257], time_issuer[65], time_key[513];
} pet_transport_config_t;
typedef struct {
    uint32_t version;
    pet_transport_config_t transport[2];
    pet_network_t networks[PET_NETWORK_MAX];
    uint8_t network_count, active_network, mode;
} pet_config_t;
typedef struct {
    pet_transport_config_t profile;
    pet_network_t network;
    uint32_t utc_seconds;
    pet_transport_t target;
    int replace_slot;
    bool has_network, has_profile;
} pet_candidate_t;
bool pet_config_profile_valid(const pet_transport_config_t *profile);
bool pet_config_valid(const pet_config_t *config);
bool pet_config_parse_setup(const char *json,size_t len,pet_candidate_t *candidate);
/* -1 means append/match. Full tables require an explicit replacement index. */
int pet_config_network_slot(const pet_config_t *config,const pet_candidate_t *candidate);
bool pet_config_commit(pet_config_t *config,const pet_candidate_t *candidate);
