/* Reference peripheral for the documented ZAOC FF00 protocol.
 * MQTT/custom/receipt framing is our explicit development profile.
 * No audio, hardware amplification or production activation is claimed. */
#include <string.h>
#include <stdlib.h>
#include <inttypes.h>
#include <time.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "esp_timer.h"
#include "driver/gpio.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "mqtt_client.h"
#include "cJSON.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "reference_config.h"

static const char *TAG = "partner_ref";
static EventGroupHandle_t wifi_events;
static QueueHandle_t jobs, commands;
static nvs_handle_t storage;
static uint8_t mac[6], own_addr_type;
static uint16_t connection = BLE_HS_CONN_HANDLE_NONE, ssid_handle, password_handle, status_handle;
static bool ssid_notify, status_notify, configuring, connecting, wifi_ok, mqtt_ready, provision_success;
static char ble_name[20], mac_text[18], external_id[13], connection_id[40];
static char up_topic[160], down_topic[160], input[513];
static size_t input_len;
static uint32_t sequence, revision, execution_count;
static uint8_t volume = 60;
static esp_mqtt_client_handle_t mqtt;
static char receipt_id[81], receipt_status[8], receipt_error[80];
static uint32_t receipt_revision;
static uint8_t receipt_volume;
static char mqtt_input[8193];
static int mqtt_input_len;
static const ble_uuid16_t svc_uuid = BLE_UUID16_INIT(0xff00), ssid_uuid = BLE_UUID16_INIT(0xff01), password_uuid = BLE_UUID16_INIT(0xff02), status_uuid = BLE_UUID16_INIT(0xff03);
struct wifi_job { bool scan; char ssid[33]; char password[65]; };
struct command_job { char json[2048]; };
static void advertise(void);
static void uuid(char *dest, size_t capacity) { snprintf(dest, capacity, "%08" PRIx32 "-%08" PRIx32 "-%08" PRIx32, esp_random(), esp_random(), esp_random()); }
static double now_ms(void) { struct timeval t; gettimeofday(&t, NULL); return (double)t.tv_sec * 1000 + t.tv_usec / 1000; }
static const char *json_string(cJSON *object, const char *key) { const cJSON *v = cJSON_GetObjectItemCaseSensitive(object, key); return cJSON_IsString(v) ? v->valuestring : NULL; }
static void notify(const char *text) {
    if (connection == BLE_HS_CONN_HANDLE_NONE) return;
    uint16_t handle = ssid_notify ? ssid_handle : status_notify ? status_handle : 0;
    if (!handle) return;
    struct os_mbuf *buffer = ble_hs_mbuf_from_flat(text, strlen(text));
    if (buffer) ble_gatts_notify_custom(connection, handle, buffer);
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        wifi_ok = true; xEventGroupSetBits(wifi_events, 1);
        ESP_LOGI(TAG, "Wi-Fi acquired IP");
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_ok = false;
        if (connecting) xEventGroupSetBits(wifi_events, 2);
        if (!configuring) esp_wifi_connect();
    }
}
static bool join_wifi(const char *ssid, const char *password) {
    connecting = false; esp_wifi_disconnect(); vTaskDelay(pdMS_TO_TICKS(250));
    xEventGroupClearBits(wifi_events, 3);
    wifi_config_t config = {0};
    memcpy(config.sta.ssid, ssid, strlen(ssid)); memcpy(config.sta.password, password, strlen(password));
    config.sta.pmf_cfg.capable = true;
    esp_err_t error = esp_wifi_set_config(WIFI_IF_STA, &config);
    connecting = true;
    if (error == ESP_OK) error = esp_wifi_connect();
    EventBits_t bits = error == ESP_OK ? xEventGroupWaitBits(wifi_events, 3, pdTRUE, pdFALSE, pdMS_TO_TICKS(30000)) : 0;
    connecting = false;
    return (bits & 1) != 0;
}
static void wifi_worker(void *arg) {
    struct wifi_job job;
    while (xQueueReceive(jobs, &job, portMAX_DELAY)) {
        if (job.scan) {
            wifi_scan_config_t config = {0};
            if (esp_wifi_scan_start(&config, true) != ESP_OK) { notify("FAILED:WiFi scan failed"); continue; }
            uint16_t count = 0; esp_wifi_scan_get_ap_num(&count);
            if (count > 48) count = 48;
            wifi_ap_record_t *records = calloc(count ? count : 1, sizeof(*records));
            if (!records) { notify("FAILED:No memory"); continue; }
            esp_wifi_scan_get_ap_records(&count, records);
            for (uint16_t i=0; i<count; i++) { if (records[i].ssid[0]) { notify((char *)records[i].ssid); vTaskDelay(pdMS_TO_TICKS(15)); } }
            free(records); ESP_LOGI(TAG, "Wi-Fi scan notifications sent: %u", count);
        } else {
            bool success = join_wifi(job.ssid, job.password);
            if (success) {
                nvs_set_str(storage, "ssid", job.ssid); nvs_set_str(storage, "password", job.password); nvs_set_u8(storage, "configured", 1);
                if (nvs_commit(storage) != ESP_OK) { notify("{\"status\":\"0\"}"); continue; }
                provision_success=true; notify("{\"status\":\"1\"}"); ESP_LOGI(TAG, "Wi-Fi result=1; restart in 2 seconds");
                vTaskDelay(pdMS_TO_TICKS(2000)); if (connection != BLE_HS_CONN_HANDLE_NONE) ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
                esp_restart();
            } else { notify("{\"status\":\"0\"}"); ESP_LOGI(TAG, "Wi-Fi result=0; BLE connection retained for retry"); }
        }
        memset(&job, 0, sizeof(job));
    }
}
static int gatt_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) { const char *value = attr == status_handle ? "ready" : ""; return os_mbuf_append(ctxt->om, value, strlen(value)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES; }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR || attr != ssid_handle) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    if (!ssid_notify || !status_notify) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len + input_len > 512) { input_len = 0; notify("FAILED:ERROR: Data too large or corrupted"); return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN; }
    ble_hs_mbuf_to_flat(ctxt->om, input + input_len, 512 - input_len, NULL); input_len += len; input[input_len] = 0;
    struct wifi_job job = {0};
    if (input_len == 4 && memcmp(input, "scan", 4) == 0) { job.scan = true; input_len = 0; }
    else {
        cJSON *json = cJSON_Parse(input);
        if (!json) return 0; // documented multiple-write JSON accumulation
        const char *ssid = json_string(json, "ssid"), *password = json_string(json, "password");
        if (!ssid || !password || !strlen(ssid) || strlen(ssid)>32 || strlen(password)>64) { input_len=0; cJSON_Delete(json); notify("FAILED:ERROR: Invalid ssid/password"); return 0; }
        strcpy(job.ssid, ssid); strcpy(job.password, password); input_len=0; cJSON_Delete(json);
    }
    if (xQueueSend(jobs, &job, 0) != pdTRUE) notify("FAILED:Device busy");
    memset(input, 0, sizeof(input)); return 0;
}
static const struct ble_gatt_svc_def services[] = {{ .type=BLE_GATT_SVC_TYPE_PRIMARY, .uuid=&svc_uuid.u,
    .characteristics=(struct ble_gatt_chr_def[]) {
        { .uuid=&ssid_uuid.u, .access_cb=gatt_access, .flags=BLE_GATT_CHR_F_READ|BLE_GATT_CHR_F_WRITE|BLE_GATT_CHR_F_NOTIFY, .val_handle=&ssid_handle },
        { .uuid=&password_uuid.u, .access_cb=gatt_access, .flags=BLE_GATT_CHR_F_READ|BLE_GATT_CHR_F_WRITE|BLE_GATT_CHR_F_NOTIFY, .val_handle=&password_handle },
        { .uuid=&status_uuid.u, .access_cb=gatt_access, .flags=BLE_GATT_CHR_F_READ|BLE_GATT_CHR_F_NOTIFY, .val_handle=&status_handle }, {0} } }, {0} };
static int gap_event(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT: if (event->connect.status==0) { connection=event->connect.conn_handle; ESP_LOGI(TAG, "BLE connected"); } else advertise(); break;
    case BLE_GAP_EVENT_DISCONNECT: connection=BLE_HS_CONN_HANDLE_NONE; ssid_notify=status_notify=false; input_len=0; if (!provision_success) advertise(); break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle==ssid_handle) ssid_notify=event->subscribe.cur_notify;
        if (event->subscribe.attr_handle==status_handle) status_notify=event->subscribe.cur_notify;
        ESP_LOGI(TAG, "Notify enabled FF01=%d FF03=%d", ssid_notify, status_notify); break;
    case BLE_GAP_EVENT_ADV_COMPLETE: advertise(); break;
    default: break;
    } return 0;
}
static void advertise(void) {
    struct ble_hs_adv_fields fields = {0};
    static uint8_t manufacturer[8]; manufacturer[0]=0; manufacturer[1]=1; memcpy(manufacturer+2, mac, 6);
    fields.flags=BLE_HS_ADV_F_DISC_GEN|BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name=(uint8_t *)ble_name; fields.name_len=strlen(ble_name); fields.name_is_complete=1;
    fields.mfg_data=manufacturer; fields.mfg_data_len=8;
    // Intentionally no advertised service UUID.
    ble_gap_adv_set_fields(&fields);
    struct ble_gap_adv_params params = { .conn_mode=BLE_GAP_CONN_MODE_UND, .disc_mode=BLE_GAP_DISC_MODE_GEN, .itvl_min=0x20, .itvl_max=0x40 };
    int rc=ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    ESP_LOGI(TAG, "Advertising %s, rc=%d, no service UUID", ble_name, rc);
}
static void synced(void) { ble_hs_util_ensure_addr(0); ble_hs_id_infer_auto(0, &own_addr_type); advertise(); }
static void ble_host(void *arg) { nimble_port_run(); nimble_port_freertos_deinit(); }
static void ble_start(void) {
    ESP_ERROR_CHECK(nimble_port_init()); ble_hs_cfg.sync_cb=synced;
    ble_svc_gap_init(); ble_svc_gatt_init(); ble_svc_gap_device_name_set(ble_name);
    assert(ble_gatts_count_cfg(services)==0); assert(ble_gatts_add_svcs(services)==0);
    nimble_port_freertos_init(ble_host);
}
static cJSON *message(const char *type) {
    cJSON *json=cJSON_CreateObject(); char event_id[40]; uuid(event_id,sizeof(event_id));
    cJSON_AddStringToObject(json,"type",type); cJSON_AddStringToObject(json,"eventId",event_id);
    cJSON_AddStringToObject(json,"connectionId",connection_id); cJSON_AddNumberToObject(json,"sequence",__atomic_add_fetch(&sequence,1,__ATOMIC_SEQ_CST)); cJSON_AddNumberToObject(json,"ts",now_ms()); return json;
}
static void publish(cJSON *json) { char *text=cJSON_PrintUnformatted(json); if (text && mqtt_ready) esp_mqtt_client_publish(mqtt,up_topic,text,0,1,0); free(text); cJSON_Delete(json); }
static void report_status(void) { cJSON *json=message("status"); cJSON_AddNumberToObject(json,"volume",volume); cJSON_AddNumberToObject(json,"revision",revision); publish(json); }
static void acknowledge(void) {
    cJSON *json=message("cmd_ack"), *result=cJSON_AddObjectToObject(json,"result");
    cJSON_AddStringToObject(json,"commandId",receipt_id); cJSON_AddStringToObject(json,"status",receipt_status);
    if (receipt_error[0]) cJSON_AddStringToObject(json,"error",receipt_error);
    cJSON_AddNumberToObject(result,"volume",receipt_volume); cJSON_AddNumberToObject(result,"revision",receipt_revision); cJSON_AddNumberToObject(result,"executionCount",execution_count); publish(json);
}
static void command_worker(void *arg) {
    struct command_job job;
    while (xQueueReceive(commands,&job,portMAX_DELAY)) {
        cJSON *json=cJSON_Parse(job.json);
        const char *type=json_string(json,"type");
        if (type && strcmp(type,"status.request")==0) { report_status(); cJSON_Delete(json); continue; }
        cJSON *payload=cJSON_GetObjectItemCaseSensitive(json,"payload"), *args=cJSON_GetObjectItemCaseSensitive(payload,"args");
        const char *id=json_string(payload,"id"), *cmd=json_string(payload,"cmd");
        cJSON *value=cJSON_GetObjectItemCaseSensitive(args,"value"), *rev=cJSON_GetObjectItemCaseSensitive(args,"revision"), *expiry=cJSON_GetObjectItemCaseSensitive(payload,"expiresAt");
        if (!type || strcmp(type,"custom") || !id || strlen(id)>80 || !cmd || strcmp(cmd,"set_volume") || !cJSON_IsNumber(value) || !cJSON_IsNumber(rev) || !cJSON_IsNumber(expiry)) { cJSON_Delete(json); continue; }
        if (strcmp(id,receipt_id)==0) { acknowledge(); report_status(); cJSON_Delete(json); continue; }
        const char *error=NULL;
        if (value->valuedouble<0 || value->valuedouble>100 || value->valuedouble!=value->valueint || rev->valuedouble<1 || rev->valuedouble!=rev->valueint) error="invalid_command";
        else if (expiry->valuedouble<=now_ms()) error="command_expired";
        else if (rev->valuedouble<=revision) error="superseded_revision";
        strcpy(receipt_id,id); strcpy(receipt_status,error?"error":"ok"); snprintf(receipt_error,sizeof(receipt_error),"%s",error?error:"");
        if (!error) { volume=value->valueint; revision=rev->valueint; execution_count++; }
        receipt_volume=volume; receipt_revision=revision;
        nvs_set_u8(storage,"volume",volume); nvs_set_u32(storage,"revision",revision); nvs_set_u32(storage,"executions",execution_count);
        nvs_set_str(storage,"receipt_id",receipt_id); nvs_set_str(storage,"receipt_status",receipt_status); nvs_set_str(storage,"receipt_error",receipt_error);
        nvs_set_u8(storage,"receipt_volume",receipt_volume); nvs_set_u32(storage,"receipt_rev",receipt_revision);
        if (nvs_commit(storage)==ESP_OK) { ESP_LOGI(TAG,"Command %s result=%s volume=%u revision=%" PRIu32 " executions=%" PRIu32,id,receipt_status,volume,revision,execution_count); acknowledge(); report_status(); }
        else ESP_LOGE(TAG,"State persistence failed; no execution ACK sent");
        cJSON_Delete(json);
    }
}
static void mqtt_event(void *arg, esp_event_base_t base, int32_t event_id, void *data) {
    esp_mqtt_event_handle_t event=data;
    if (event_id==MQTT_EVENT_CONNECTED) { esp_mqtt_client_subscribe(mqtt,down_topic,1); ESP_LOGI(TAG,"MQTT connected"); }
    if (event_id==MQTT_EVENT_SUBSCRIBED) { mqtt_ready=true; report_status(); }
    if (event_id==MQTT_EVENT_DISCONNECTED) { mqtt_ready=false; ESP_LOGW(TAG,"MQTT disconnected"); }
    if (event_id==MQTT_EVENT_DATA) {
        if (event->current_data_offset==0) { mqtt_input_len=0; if (event->topic_len!=(int)strlen(down_topic) || memcmp(event->topic,down_topic,event->topic_len)) return; }
        if (event->total_data_len>2047 || event->current_data_offset!=mqtt_input_len) { mqtt_input_len=0; return; }
        memcpy(mqtt_input+mqtt_input_len,event->data,event->data_len); mqtt_input_len+=event->data_len;
        if (mqtt_input_len==event->total_data_len) { mqtt_input[mqtt_input_len]=0; struct command_job job; strcpy(job.json,mqtt_input); if (xQueueSend(commands,&job,0)!=pdTRUE) ESP_LOGW(TAG,"Command queue full"); mqtt_input_len=0; }
    }
}
struct http_response { char bytes[4096]; size_t len; };
static esp_err_t http_event(esp_http_client_event_t *event) {
    struct http_response *r=event->user_data;
    if (event->event_id==HTTP_EVENT_ON_DATA) { if (r->len+event->data_len>=sizeof(r->bytes)) return ESP_FAIL; memcpy(r->bytes+r->len,event->data,event->data_len); r->len+=event->data_len; r->bytes[r->len]=0; } return ESP_OK;
}
static bool bootstrap(void) {
    struct http_response response={0};
    esp_http_client_config_t config={ .url=REFERENCE_BOOTSTRAP_URL, .method=HTTP_METHOD_POST, .timeout_ms=10000, .event_handler=http_event, .user_data=&response };
    esp_http_client_handle_t client=esp_http_client_init(&config);
    char bearer[120]; snprintf(bearer,sizeof(bearer),"Bearer %s",REFERENCE_BOOTSTRAP_SECRET);
    esp_http_client_set_header(client,"Authorization",bearer); esp_http_client_set_header(client,"Device-Id",mac_text); esp_http_client_set_header(client,"Client-Id",REFERENCE_CLIENT_UUID);
    esp_http_client_set_header(client,"Content-Type","application/json"); esp_http_client_set_header(client,"Activation-Version","1"); esp_http_client_set_header(client,"User-Agent","shouban-reference/0.2.0"); esp_http_client_set_header(client,"Accept-Language","zh-CN");
    char body[320]; snprintf(body,sizeof(body),"{\"version\":2,\"mac_address\":\"%s\",\"uuid\":\"%s\",\"application\":{\"name\":\"shouban-reference\",\"version\":\"0.2.0\"}}",mac_text,REFERENCE_CLIENT_UUID);
    esp_http_client_set_post_field(client,body,strlen(body)); esp_err_t rc=esp_http_client_perform(client); int status=esp_http_client_get_status_code(client); esp_http_client_cleanup(client);
    if (rc!=ESP_OK || status!=200) { ESP_LOGW(TAG,"Bootstrap failed rc=%d status=%d",rc,status); return false; }
    cJSON *json=cJSON_Parse(response.bytes), *m=cJSON_GetObjectItemCaseSensitive(json,"mqtt"), *server=cJSON_GetObjectItemCaseSensitive(json,"server_time"), *timestamp=cJSON_GetObjectItemCaseSensitive(server,"timestamp");
    const char *transport=json_string(json,"reference_transport");
    if (!transport || strcmp(transport,"tcp")) { ESP_LOGE(TAG,"Reference build supports local TCP only; refusing incompatible transport"); cJSON_Delete(json); return false; }
    const char *endpoint=json_string(m,"endpoint"), *client_id=json_string(m,"client_id"), *user=json_string(m,"username"), *password=json_string(m,"password"), *up=json_string(m,"publish_topic"), *down=json_string(m,"subscribe_topic");
    if (!endpoint || !client_id || !user || !password || !up || !down || strlen(up)>=sizeof(up_topic) || strlen(down)>=sizeof(down_topic) || !cJSON_IsNumber(timestamp)) { cJSON_Delete(json); return false; }
    struct timeval t={ .tv_sec=(time_t)(timestamp->valuedouble/1000), .tv_usec=((int64_t)timestamp->valuedouble%1000)*1000 }; settimeofday(&t,NULL);
    strcpy(up_topic,up); strcpy(down_topic,down); uuid(connection_id,sizeof(connection_id)); sequence=0;
    cJSON *will=cJSON_CreateObject(); char event_id[40]; uuid(event_id,sizeof(event_id));
    cJSON_AddStringToObject(will,"type","presence"); cJSON_AddStringToObject(will,"state","offline"); cJSON_AddStringToObject(will,"connectionId",connection_id); cJSON_AddStringToObject(will,"eventId",event_id);
    char *will_text=cJSON_PrintUnformatted(will); char uri[160]; snprintf(uri,sizeof(uri),"mqtt://%s",endpoint);
    esp_mqtt_client_config_t mqtt_config={ .broker.address.uri=uri, .credentials.client_id=client_id, .credentials.username=user, .credentials.authentication.password=password,
        .session.keepalive=30, .session.last_will.topic=up_topic, .session.last_will.msg=will_text, .session.last_will.qos=1, .session.last_will.retain=1, .buffer.size=4096 };
    mqtt=esp_mqtt_client_init(&mqtt_config); free(will_text); cJSON_Delete(will); cJSON_Delete(json);
    if (!mqtt) return false;
    esp_mqtt_client_register_event(mqtt,ESP_EVENT_ANY_ID,mqtt_event,NULL); esp_mqtt_client_start(mqtt); ESP_LOGI(TAG,"Bootstrap authenticated; MQTT configured"); return true;
}
static void cloud_worker(void *arg) {
    while (!wifi_ok) vTaskDelay(pdMS_TO_TICKS(250));
    while (!bootstrap()) vTaskDelay(pdMS_TO_TICKS(3000));
    while (1) { if (mqtt_ready) report_status(); vTaskDelay(pdMS_TO_TICKS(5000)); }
}
static void button_worker(void *arg) {
    gpio_config_t config={ .pin_bit_mask=1ULL<<0, .mode=GPIO_MODE_INPUT, .pull_up_en=GPIO_PULLUP_ENABLE }; gpio_config(&config);
    int count=0;
    while (1) { count=gpio_get_level(0)==0?count+1:0; if (count>=50) { nvs_set_u8(storage,"configured",0); nvs_commit(storage); ESP_LOGI(TAG,"BOOT long press: restart into ZAOC provisioning"); esp_restart(); } vTaskDelay(pdMS_TO_TICKS(100)); }
}
void app_main(void) {
    ESP_ERROR_CHECK(nvs_flash_init()); ESP_ERROR_CHECK(nvs_open("partner_ref",NVS_READWRITE,&storage));
    esp_read_mac(mac,ESP_MAC_WIFI_STA);
    snprintf(mac_text,sizeof(mac_text),"%02x:%02x:%02x:%02x:%02x:%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    snprintf(external_id,sizeof(external_id),"%02x%02x%02x%02x%02x%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    snprintf(ble_name,sizeof(ble_name),"ZAOC_%02X%02X%02X",mac[3],mac[4],mac[5]);
    nvs_get_u8(storage,"volume",&volume); nvs_get_u32(storage,"revision",&revision); nvs_get_u32(storage,"executions",&execution_count);
    size_t size=sizeof(receipt_id); nvs_get_str(storage,"receipt_id",receipt_id,&size); size=sizeof(receipt_status); nvs_get_str(storage,"receipt_status",receipt_status,&size); size=sizeof(receipt_error); nvs_get_str(storage,"receipt_error",receipt_error,&size);
    nvs_get_u8(storage,"receipt_volume",&receipt_volume); nvs_get_u32(storage,"receipt_rev",&receipt_revision);
    wifi_events=xEventGroupCreate(); jobs=xQueueCreate(2,sizeof(struct wifi_job)); commands=xQueueCreate(4,sizeof(struct command_job));
    ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default()); esp_netif_create_default_wifi_sta();
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&init)); ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL)); ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_start());
    uint8_t configured=0; nvs_get_u8(storage,"configured",&configured); configuring=!configured;
    xTaskCreate(button_worker,"setup_button",3072,NULL,4,NULL);
    ESP_LOGI(TAG,"Reference boot identity=%s volume=%u revision=%" PRIu32,external_id,volume,revision);
    if (!configured) { ble_start(); xTaskCreate(wifi_worker,"ble_wifi_worker",6144,NULL,5,NULL); }
    else { char ssid[33]={0}, password[65]={0}; size=sizeof(ssid); nvs_get_str(storage,"ssid",ssid,&size); size=sizeof(password); nvs_get_str(storage,"password",password,&size);
        wifi_config_t cfg={0}; memcpy(cfg.sta.ssid,ssid,strlen(ssid)); memcpy(cfg.sta.password,password,strlen(password)); esp_wifi_set_config(WIFI_IF_STA,&cfg); esp_wifi_connect();
        memset(password,0,sizeof(password)); xTaskCreate(command_worker,"command_worker",8192,NULL,5,NULL); xTaskCreate(cloud_worker,"bootstrap_mqtt",8192,NULL,4,NULL); }
}
