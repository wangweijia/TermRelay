#pragma once
#include "authorization.h"
#include <nlohmann/json.hpp>

namespace connection {
// Parse a complete bounded page before publishing anything to the UI.
void apply_listing_page(ListingSnapshot& snapshot, const nlohmann::json& payload,
                        const std::string& device_id, const std::string& cursor);
}
