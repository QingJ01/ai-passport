cmake_minimum_required(VERSION 3.20)
project(agent_pet_host_preview C CXX)
set(CMAKE_C_STANDARD 11)
get_filename_component(REPO "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/lv_conf.h" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
# Local-only check of main/local artwork. Never use it to render docs/assets.
option(PET_LOCAL_OVERRIDE "Preview with the gitignored main/local whale override" OFF)
add_subdirectory("${REPO}/managed_components/lvgl__lvgl" lvgl)
add_executable(ui-preview preview.c "${REPO}/main/agent_pet_model.c" "${REPO}/main/agent_pet_text.c"
    "${REPO}/main/agent_pet_mood.c" "${REPO}/main/pet_critter_img.c" "${REPO}/main/pet_critter_big_img.c"
    "${REPO}/components/bsp/src/bsp_display_rounding.c"
    "${REPO}/assets/fonts/agent-pet/pet_font_cjk_16.c" "${REPO}/assets/fonts/agent-pet/pet_font_ui_14.c"
    "${REPO}/assets/fonts/agent-pet/pet_font_ui_24.c" "${REPO}/assets/fonts/agent-pet/pet_font_num_40.c")
if(PET_LOCAL_OVERRIDE AND EXISTS "${REPO}/main/local/pet_whale_override.c")
    target_sources(ui-preview PRIVATE "${REPO}/main/local/pet_whale_override.c")
    target_compile_definitions(ui-preview PRIVATE PET_WHALE_OVERRIDE=1)
else()
    target_sources(ui-preview PRIVATE "${REPO}/main/pet_whale_img.c" "${REPO}/main/pet_whale_big_img.c")
endif()
target_include_directories(ui-preview PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" "${REPO}/main" "${REPO}/assets/fonts/agent-pet" "${REPO}/components/bsp/include" "${REPO}/components/bsp/src")
target_link_libraries(ui-preview PRIVATE lvgl m)
