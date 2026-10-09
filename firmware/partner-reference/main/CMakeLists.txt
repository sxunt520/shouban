idf_component_register(SRCS "partner_reference.c" INCLUDE_DIRS "."
 REQUIRES bt esp_wifi esp_event esp_netif esp_http_client nvs_flash esp_driver_gpio esp_timer mbedtls)
