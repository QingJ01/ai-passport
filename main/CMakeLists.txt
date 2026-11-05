idf_component_register(
    SRCS "main.c" "agent_pet_input.c" "agent_pet_model.c" "agent_pet_config.c" "agent_pet_action.c" "agent_pet_runtime.c" "agent_pet_provisioning.c" "agent_pet_time.c"
    INCLUDE_DIRS "." "../assets/fonts/agent-pet"
    REQUIRES bsp esp_event esp_hw_support esp_netif esp_timer esp_wifi nvs_flash
             esp_websocket_client mbedtls json esp_driver_usb_serial_jtag wifi_provisioning protocomm bt esp_http_client esp_app_format
)
target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/agent-pet/pet_font_cjk_16.c")
