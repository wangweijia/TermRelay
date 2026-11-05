#include "listing_protocol.h"
#include <algorithm>
#include <set>
#include <stdexcept>

namespace connection {
namespace {
using Json = nlohmann::json;
std::string text(const Json& object, const char* key, std::size_t maximum, bool empty = false) {
    const auto& value = object.at(key);
    if (!value.is_string()) throw std::runtime_error("Invalid list text");
    auto result = value.get<std::string>();
    const auto characters = std::count_if(result.begin(), result.end(), [](unsigned char byte) { return (byte & 0xc0) != 0x80; });
    if ((!empty && result.empty()) || result.size() > 4 * maximum || static_cast<std::size_t>(characters) > maximum || result.find('\0') != std::string::npos)
        throw std::runtime_error("Invalid list text");
    return result;
}
std::string choice(const Json& object, const char* key, std::initializer_list<const char*> values) {
    auto result = text(object, key, 32);
    if (std::none_of(values.begin(), values.end(), [&](const char* value) { return result == value; }))
        throw std::runtime_error("Invalid list status");
    return result;
}
}
void apply_listing_page(ListingSnapshot& snapshot, const Json& payload,
                        const std::string& device_id, const std::string& cursor) {
    if (!payload.is_object() || payload.size() != (device_id.empty() ? 3u : 4u)) throw std::runtime_error("Invalid list response");
    const auto& items = payload.at("items");
    if (!items.is_array() || items.size() > 20) throw std::runtime_error("List page too large");
    const auto next = payload.at("nextCursor").is_null() ? "" : text(payload, "nextCursor", 128);
    std::set<std::string> ids;
    std::vector<DeviceSummary> devices;
    std::vector<SessionSummary> sessions;
    if (!device_id.empty() && text(payload, "deviceId", 128) != device_id) throw std::runtime_error("Wrong list device");
    for (const auto& item : items) {
        if (!item.is_object() || item.size() != (device_id.empty() ? 4u : 7u)) throw std::runtime_error("Invalid list item");
        auto id = text(item, "id", 128);
        if (!ids.insert(id).second) throw std::runtime_error("Duplicate list item");
        if (device_id.empty()) {
            devices.push_back({id, text(item, "name", 128, true),
                choice(item, "status", {"connected", "connecting", "offline", "degraded"}),
                choice(item, "platform", {"macOS", "linux"})});
        } else {
            auto target = text(item, "deviceId", 128);
            if (target != device_id) throw std::runtime_error("Wrong session device");
            sessions.push_back({id, target, text(item, "workspaceId", 128), text(item, "toolKey", 64, true),
                item.at("displayName").is_null() ? "" : text(item, "displayName", 128, true),
                choice(item, "runtimeMode", {"acp", "pty"}),
                choice(item, "status", {"starting", "running", "stopping", "finished", "failed"})});
        }
    }
    if (!next.empty() && (items.empty() || next != items.back().at("id") || next == cursor))
        throw std::runtime_error("Invalid list cursor");
    // All checks succeeded; partial or malformed pages never replace a cached page.
    if (device_id.empty()) { snapshot.devices = std::move(devices); snapshot.next_devices = next; }
    else { snapshot.sessions = std::move(sessions); snapshot.next_sessions = next; snapshot.device_id = device_id; }
    snapshot.loading = false; snapshot.error.clear(); snapshot.revision++;
}
}
