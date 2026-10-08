#include "rc522.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

enum {
    RC522_REG_COMMAND = 0x01,
    RC522_REG_COM_IRQ = 0x04,
    RC522_REG_DIV_IRQ = 0x05,
    RC522_REG_ERROR = 0x06,
    RC522_REG_FIFO_DATA = 0x09,
    RC522_REG_FIFO_LEVEL = 0x0A,
    RC522_REG_CONTROL = 0x0C,
    RC522_REG_BIT_FRAMING = 0x0D,
    RC522_REG_COLL = 0x0E,
    RC522_REG_MODE = 0x11,
    RC522_REG_TX_CONTROL = 0x14,
    RC522_REG_TX_ASK = 0x15,
    RC522_REG_CRC_RESULT_H = 0x21,
    RC522_REG_CRC_RESULT_L = 0x22,
    RC522_REG_RF_CFG = 0x26,
    RC522_REG_T_MODE = 0x2A,
    RC522_REG_T_PRESCALER = 0x2B,
    RC522_REG_T_RELOAD_H = 0x2C,
    RC522_REG_T_RELOAD_L = 0x2D,
    RC522_REG_VERSION = 0x37,
};

enum {
    RC522_CMD_IDLE = 0x00,
    RC522_CMD_CALC_CRC = 0x03,
    RC522_CMD_TRANSCEIVE = 0x0C,
    RC522_CMD_SOFT_RESET = 0x0F,
};

enum {
    PICC_CMD_WUPA = 0x52,
    PICC_CMD_SEL_CL1 = 0x93,
    PICC_CMD_SEL_CL2 = 0x95,
    PICC_CMD_SEL_CL3 = 0x97,
    PICC_CASCADE_TAG = 0x88,
};

static const char *TAG = "rc522";
static spi_device_handle_t rc522_spi;

static uint8_t register_address(uint8_t reg, bool read)
{
    return (uint8_t)(((reg << 1) & 0x7E) | (read ? 0x80 : 0x00));
}

static esp_err_t write_register(uint8_t reg, uint8_t value)
{
    spi_transaction_t transaction = {
        .length = 16,
        .flags = SPI_TRANS_USE_TXDATA,
    };
    transaction.tx_data[0] = register_address(reg, false);
    transaction.tx_data[1] = value;
    return spi_device_polling_transmit(rc522_spi, &transaction);
}

static esp_err_t read_register(uint8_t reg, uint8_t *value)
{
    ESP_RETURN_ON_FALSE(value != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "register output is NULL");
    spi_transaction_t transaction = {
        .length = 16,
        .flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA,
    };
    transaction.tx_data[0] = register_address(reg, true);
    transaction.tx_data[1] = 0;
    ESP_RETURN_ON_ERROR(spi_device_polling_transmit(rc522_spi, &transaction),
                        TAG, "SPI read failed");
    *value = transaction.rx_data[1];
    return ESP_OK;
}

static esp_err_t set_register_bits(uint8_t reg, uint8_t mask)
{
    uint8_t value = 0;
    ESP_RETURN_ON_ERROR(read_register(reg, &value), TAG, "read before set failed");
    return write_register(reg, (uint8_t)(value | mask));
}

static esp_err_t clear_register_bits(uint8_t reg, uint8_t mask)
{
    uint8_t value = 0;
    ESP_RETURN_ON_ERROR(read_register(reg, &value), TAG, "read before clear failed");
    return write_register(reg, (uint8_t)(value & (uint8_t)~mask));
}

static esp_err_t calculate_crc(const uint8_t *data, size_t length, uint8_t result[2])
{
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_COMMAND, RC522_CMD_IDLE), TAG,
                        "CRC idle failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_DIV_IRQ, 0x04), TAG,
                        "CRC IRQ clear failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_FIFO_LEVEL, 0x80), TAG,
                        "CRC FIFO flush failed");
    for (size_t index = 0; index < length; ++index) {
        ESP_RETURN_ON_ERROR(write_register(RC522_REG_FIFO_DATA, data[index]), TAG,
                            "CRC FIFO write failed");
    }
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_COMMAND, RC522_CMD_CALC_CRC), TAG,
                        "CRC command failed");

    for (unsigned attempt = 0; attempt < 50; ++attempt) {
        uint8_t irq = 0;
        ESP_RETURN_ON_ERROR(read_register(RC522_REG_DIV_IRQ, &irq), TAG,
                            "CRC IRQ read failed");
        if ((irq & 0x04) != 0) {
            ESP_RETURN_ON_ERROR(read_register(RC522_REG_CRC_RESULT_L, &result[0]),
                                TAG, "CRC low read failed");
            ESP_RETURN_ON_ERROR(read_register(RC522_REG_CRC_RESULT_H, &result[1]),
                                TAG, "CRC high read failed");
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return ESP_ERR_TIMEOUT;
}

static esp_err_t transceive(const uint8_t *send_data, size_t send_length,
                            uint8_t tx_last_bits, uint8_t *receive_data,
                            size_t *receive_length, uint8_t *receive_valid_bits)
{
    ESP_RETURN_ON_FALSE(send_data != NULL && send_length > 0 &&
                            receive_data != NULL && receive_length != NULL,
                        ESP_ERR_INVALID_ARG, TAG, "invalid transceive arguments");

    ESP_RETURN_ON_ERROR(write_register(RC522_REG_COMMAND, RC522_CMD_IDLE), TAG,
                        "idle command failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_COM_IRQ, 0x7F), TAG,
                        "IRQ clear failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_FIFO_LEVEL, 0x80), TAG,
                        "FIFO flush failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_BIT_FRAMING,
                                       (uint8_t)(tx_last_bits & 0x07)),
                        TAG, "bit framing failed");
    for (size_t index = 0; index < send_length; ++index) {
        ESP_RETURN_ON_ERROR(write_register(RC522_REG_FIFO_DATA, send_data[index]),
                            TAG, "FIFO write failed");
    }
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_COMMAND, RC522_CMD_TRANSCEIVE),
                        TAG, "transceive command failed");
    ESP_RETURN_ON_ERROR(set_register_bits(RC522_REG_BIT_FRAMING, 0x80), TAG,
                        "start-send failed");

    uint8_t irq = 0;
    bool finished = false;
    for (unsigned attempt = 0; attempt < 50; ++attempt) {
        ESP_RETURN_ON_ERROR(read_register(RC522_REG_COM_IRQ, &irq), TAG,
                            "IRQ read failed");
        if ((irq & 0x30) != 0) {
            finished = true;
            break;
        }
        if ((irq & 0x01) != 0) break;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    (void)clear_register_bits(RC522_REG_BIT_FRAMING, 0x80);
    if (!finished) return ESP_ERR_TIMEOUT;

    uint8_t error = 0;
    ESP_RETURN_ON_ERROR(read_register(RC522_REG_ERROR, &error), TAG,
                        "error register read failed");
    if ((error & 0x1B) != 0) return ESP_ERR_INVALID_RESPONSE;

    uint8_t fifo_length = 0;
    ESP_RETURN_ON_ERROR(read_register(RC522_REG_FIFO_LEVEL, &fifo_length), TAG,
                        "FIFO length read failed");
    if (fifo_length == 0 || fifo_length > *receive_length) {
        return ESP_ERR_INVALID_SIZE;
    }
    for (uint8_t index = 0; index < fifo_length; ++index) {
        ESP_RETURN_ON_ERROR(read_register(RC522_REG_FIFO_DATA,
                                          &receive_data[index]),
                            TAG, "FIFO read failed");
    }
    *receive_length = fifo_length;
    if (receive_valid_bits != NULL) {
        uint8_t control = 0;
        ESP_RETURN_ON_ERROR(read_register(RC522_REG_CONTROL, &control), TAG,
                            "control register read failed");
        *receive_valid_bits = (uint8_t)(control & 0x07);
    }
    return ESP_OK;
}

static esp_err_t wake_card(void)
{
    const uint8_t command = PICC_CMD_WUPA;
    uint8_t atqa[2] = {0};
    size_t response_length = sizeof(atqa);
    uint8_t valid_bits = 0;
    const esp_err_t error = transceive(&command, 1, 7, atqa,
                                       &response_length, &valid_bits);
    if (error == ESP_ERR_TIMEOUT) return ESP_ERR_NOT_FOUND;
    ESP_RETURN_ON_ERROR(error, TAG, "WUPA failed");
    return response_length == 2 && valid_bits == 0
               ? ESP_OK
               : ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t anticollision_and_select(uint8_t cascade_command,
                                          uint8_t cascade_data[5],
                                          uint8_t *sak)
{
    const uint8_t anticollision[] = {cascade_command, 0x20};
    size_t response_length = 5;
    uint8_t valid_bits = 0;
    ESP_RETURN_ON_ERROR(clear_register_bits(RC522_REG_COLL, 0x80), TAG,
                        "collision setup failed");
    ESP_RETURN_ON_ERROR(transceive(anticollision, sizeof(anticollision), 0,
                                   cascade_data, &response_length, &valid_bits),
                        TAG, "UID anticollision failed");
    if (response_length != 5 || valid_bits != 0 ||
        (uint8_t)(cascade_data[0] ^ cascade_data[1] ^ cascade_data[2] ^
                  cascade_data[3]) != cascade_data[4]) {
        return ESP_ERR_INVALID_RESPONSE;
    }

    uint8_t select_frame[9] = {cascade_command, 0x70};
    memcpy(&select_frame[2], cascade_data, 5);
    ESP_RETURN_ON_ERROR(calculate_crc(select_frame, 7, &select_frame[7]), TAG,
                        "select CRC failed");

    uint8_t response[3] = {0};
    response_length = sizeof(response);
    ESP_RETURN_ON_ERROR(transceive(select_frame, sizeof(select_frame), 0,
                                   response, &response_length, &valid_bits),
                        TAG, "UID select failed");
    if (response_length != 3 || valid_bits != 0) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    *sak = response[0];
    return ESP_OK;
}

esp_err_t rc522_init(uint8_t *version)
{
    const gpio_config_t reset_config = {
        .pin_bit_mask = 1ULL << CONFIG_FIGURE_NFC_PIN_RST,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&reset_config), TAG,
                        "RST GPIO configuration failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(CONFIG_FIGURE_NFC_PIN_RST, 0), TAG,
                        "RST low failed");
    vTaskDelay(pdMS_TO_TICKS(2));
    ESP_RETURN_ON_ERROR(gpio_set_level(CONFIG_FIGURE_NFC_PIN_RST, 1), TAG,
                        "RST high failed");
    vTaskDelay(pdMS_TO_TICKS(50));

    const spi_bus_config_t bus_config = {
        .sclk_io_num = CONFIG_FIGURE_NFC_PIN_SCK,
        .mosi_io_num = CONFIG_FIGURE_NFC_PIN_MOSI,
        .miso_io_num = CONFIG_FIGURE_NFC_PIN_MISO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 16,
    };
    ESP_RETURN_ON_ERROR(
        spi_bus_initialize((spi_host_device_t)CONFIG_FIGURE_NFC_SPI_HOST,
                           &bus_config, SPI_DMA_CH_AUTO),
        TAG, "SPI bus initialization failed");

    const spi_device_interface_config_t device_config = {
        .clock_speed_hz = 4 * 1000 * 1000,
        .mode = 0,
        .spics_io_num = CONFIG_FIGURE_NFC_PIN_CS,
        .queue_size = 1,
    };
    ESP_RETURN_ON_ERROR(
        spi_bus_add_device((spi_host_device_t)CONFIG_FIGURE_NFC_SPI_HOST,
                           &device_config, &rc522_spi),
        TAG, "SPI device creation failed");

    ESP_RETURN_ON_ERROR(write_register(RC522_REG_COMMAND,
                                       RC522_CMD_SOFT_RESET),
                        TAG, "soft reset failed");
    vTaskDelay(pdMS_TO_TICKS(50));
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_T_MODE, 0x8D), TAG,
                        "timer mode setup failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_T_PRESCALER, 0x3E), TAG,
                        "timer prescaler setup failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_T_RELOAD_H, 0x00), TAG,
                        "timer reload high setup failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_T_RELOAD_L, 30), TAG,
                        "timer reload low setup failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_TX_ASK, 0x40), TAG,
                        "TX ASK setup failed");
    ESP_RETURN_ON_ERROR(write_register(RC522_REG_MODE, 0x3D), TAG,
                        "mode setup failed");
    ESP_RETURN_ON_ERROR(set_register_bits(RC522_REG_RF_CFG, 0x70), TAG,
                        "receiver gain setup failed");
    ESP_RETURN_ON_ERROR(set_register_bits(RC522_REG_TX_CONTROL, 0x03), TAG,
                        "antenna enable failed");

    uint8_t detected_version = 0;
    ESP_RETURN_ON_ERROR(read_register(RC522_REG_VERSION, &detected_version), TAG,
                        "version read failed");
    if (version != NULL) *version = detected_version;
    if (detected_version == 0x00 || detected_version == 0xFF) {
        ESP_LOGE(TAG, "Invalid version 0x%02X; check power and SPI wiring",
                 detected_version);
        return ESP_ERR_INVALID_RESPONSE;
    }
    ESP_LOGI(TAG, "MFRC522 ready, version=0x%02X SPI%d CS=%d SCK=%d MOSI=%d MISO=%d RST=%d",
             detected_version, CONFIG_FIGURE_NFC_SPI_HOST,
             CONFIG_FIGURE_NFC_PIN_CS, CONFIG_FIGURE_NFC_PIN_SCK,
             CONFIG_FIGURE_NFC_PIN_MOSI, CONFIG_FIGURE_NFC_PIN_MISO,
             CONFIG_FIGURE_NFC_PIN_RST);
    return ESP_OK;
}

esp_err_t rc522_read_uid(rc522_uid_t *uid)
{
    ESP_RETURN_ON_FALSE(uid != NULL, ESP_ERR_INVALID_ARG, TAG, "UID is NULL");
    memset(uid, 0, sizeof(*uid));
    const esp_err_t wake_error = wake_card();
    if (wake_error != ESP_OK) return wake_error;

    static const uint8_t cascade_commands[] = {
        PICC_CMD_SEL_CL1, PICC_CMD_SEL_CL2, PICC_CMD_SEL_CL3,
    };
    for (size_t level = 0; level < sizeof(cascade_commands); ++level) {
        uint8_t cascade_data[5] = {0};
        uint8_t sak = 0;
        ESP_RETURN_ON_ERROR(
            anticollision_and_select(cascade_commands[level], cascade_data, &sak),
            TAG, "cascade level %u failed", (unsigned)(level + 1));

        const size_t source_offset =
            cascade_data[0] == PICC_CASCADE_TAG ? 1 : 0;
        const size_t copy_length = source_offset == 1 ? 3 : 4;
        if (uid->length + copy_length > sizeof(uid->bytes)) {
            return ESP_ERR_INVALID_SIZE;
        }
        memcpy(&uid->bytes[uid->length], &cascade_data[source_offset],
               copy_length);
        uid->length += copy_length;

        if ((sak & 0x04) == 0) return ESP_OK;
    }
    return ESP_ERR_INVALID_RESPONSE;
}

void rc522_format_uid(const rc522_uid_t *uid, char *output, size_t output_size,
                      bool include_spaces)
{
    if (output == NULL || output_size == 0) return;
    output[0] = '\0';
    if (uid == NULL) return;

    size_t position = 0;
    for (size_t index = 0; index < uid->length; ++index) {
        const int written = snprintf(output + position, output_size - position,
                                     include_spaces && index > 0 ? " %02X" : "%02X",
                                     uid->bytes[index]);
        if (written < 0 || (size_t)written >= output_size - position) break;
        position += (size_t)written;
    }
}
