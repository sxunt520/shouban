#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define RC522_UID_MAX_LENGTH 10

typedef struct {
    uint8_t bytes[RC522_UID_MAX_LENGTH];
    size_t length;
} rc522_uid_t;

esp_err_t rc522_init(uint8_t *version);
esp_err_t rc522_read_uid(rc522_uid_t *uid);
void rc522_format_uid(const rc522_uid_t *uid, char *output, size_t output_size,
                      bool include_spaces);

#ifdef __cplusplus
}
#endif
