idf_component_register(
    SRCS "main.c" "pet_critter_img.c" "pet_critter_big_img.c" "agent_pet_mood.c" "agent_pet_text.c" "agent_pet_input.c" "agent_pet_model.c" "agent_pet_config.c" "agent_pet_action.c" "agent_pet_runtime.c" "agent_pet_provisioning.c" "agent_pet_time.c"
    INCLUDE_DIRS "." "../assets/fonts/agent-pet"
    REQUIRES bsp esp_event esp_hw_support esp_netif esp_timer esp_wifi nvs_flash
             esp_websocket_client mbedtls json esp_driver_usb_serial_jtag wifi_provisioning protocomm bt esp_http_client esp_app_format
)
# A local whale override (tools/agent_pet_sprite.py, gitignored) replaces the
# original artwork in this build only.
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/local/pet_whale_override.c")
    message(STATUS "Agent Pet: using LOCAL whale override (main/local); do not distribute this firmware")
    target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/local/pet_whale_override.c")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE PET_WHALE_OVERRIDE=1)
else()
    target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/pet_whale_img.c" "${CMAKE_CURRENT_LIST_DIR}/pet_whale_big_img.c")
endif()
target_sources(${COMPONENT_LIB} PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/agent-pet/pet_font_cjk_16.c"
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/agent-pet/pet_font_ui_14.c"
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/agent-pet/pet_font_ui_24.c"
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/agent-pet/pet_font_num_40.c")
