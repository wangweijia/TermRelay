#include "listing_protocol.h"
#include <iostream>
#include <stdexcept>

using Json = nlohmann::json;
const char* request_id = "10000000-0000-4000-8000-000000000001";
void require(bool condition) { if (!condition) throw std::runtime_error("Listing assertion failed"); }
Json device() { return {{"id", "mac-a"}, {"name", "开发设备"}, {"status", "connected"}, {"platform", "macOS"}}; }
Json page() { return {{"relatedMessageId", request_id}, {"items", Json::array({device()})}, {"nextCursor", nullptr}}; }
int main() {
    try {
        connection::ListingSnapshot snapshot;
        connection::apply_listing_page(snapshot, page(), "", "");
        require(snapshot.devices.size() == 1 && snapshot.devices[0].name == "开发设备" && snapshot.revision == 1);
        const auto invalid = [&](Json document, const std::string& target = "", const std::string& cursor = "") {
            const auto revision = snapshot.revision;
            bool rejected = false;
            try { connection::apply_listing_page(snapshot, document, target, cursor); }
            catch (const std::exception&) { rejected = true; }
            require(rejected && revision == snapshot.revision && snapshot.devices[0].name == "开发设备");
        };
        auto bad = page(); bad["items"] = Json::array();
        for (int i = 0; i < 21; i++) bad["items"].push_back(device());
        invalid(bad);
        bad = page(); bad["items"].push_back(device()); invalid(bad);
        bad = page(); bad["items"][0]["status"] = "anything"; invalid(bad);
        bad = page(); bad["items"][0]["name"] = std::string(129, 'a'); invalid(bad);
        bad = page(); bad["items"][0]["secret"] = "no extra fields"; invalid(bad);
        bad = page(); bad["nextCursor"] = "wrong"; invalid(bad);
        bad = page(); bad["nextCursor"] = "mac-a"; invalid(bad, "", "mac-a");
        bad = page(); bad["items"] = "not an array"; invalid(bad);
        bad = page(); bad["items"][0]["name"] = std::string("embedded\0text", 13); invalid(bad);
        Json sessions{{"relatedMessageId", request_id}, {"deviceId", "mac-a"}, {"nextCursor", nullptr}, {"items", Json::array({{
            {"id", "session"}, {"deviceId", "mac-a"}, {"workspaceId", "opaque"}, {"toolKey", "codex"},
            {"displayName", nullptr}, {"runtimeMode", "acp"}, {"status", "finished"},
        }})}};
        connection::apply_listing_page(snapshot, sessions, "mac-a", "");
        require(snapshot.sessions.size() == 1 && snapshot.device_id == "mac-a" && snapshot.sessions[0].name.empty());
        invalid(sessions, "other-device");
        sessions["items"][0]["deviceId"] = "forged-device"; invalid(sessions, "mac-a");
        std::string chinese;
        for (int i = 0; i < 128; i++) chinese += "字";
        auto unicode = page(); unicode["items"][0]["name"] = chinese;
        connection::apply_listing_page(snapshot, unicode, "", "");
        require(snapshot.devices[0].name == chinese);
        std::cout << "Bounded controller listing protocol passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
