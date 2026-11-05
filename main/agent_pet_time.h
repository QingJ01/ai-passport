#pragma once
#include "esp_err.h"
/* This endpoint carries public signed time only. It never receives credentials.
 * The verification key and issuer must come from an already trusted setup. */
esp_err_t pet_time_recover(const char *bootstrap_url, const char *trusted_pem,
                           const char *expected_issuer);
