#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

/* Call from application tasks, never a button/esp_timer callback. Start only
 * following an explicit physical choice. BLE lives for at most 120 seconds. */
esp_err_t pet_provision_start(void);
void pet_provision_confirm(void);
void pet_provision_stop(void);
bool pet_provision_active(void);
/* Copy the temporary screen-only pairing payload. Never print it to logs. */
bool pet_provision_qr(char *destination, size_t capacity);
/* Worker-only, physically confirmed unpair before reboot. Clear one service
 * root, preserving the device identity, other root and Wi-Fi profiles. */
esp_err_t pet_provision_forget_service(bool remote);
