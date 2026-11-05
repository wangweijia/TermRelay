#include "authorization.h"
#include <chrono>
#include <iostream>
#include <thread>

int main(int argc, char** argv) {
    if (argc != 4) return 2;
    try {
        connection::Authorization client(argv[2], true);
        client.connect(argv[1]);
        auto last = connection::State::Idle;
        bool connected = false;
        int browse_stage = 0;
        const std::string mode(argv[3]);
        auto connected_at = std::chrono::steady_clock::time_point{};
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(mode == "idle" ? 130 : mode == "timeout" ? 115 : 40);
        while (std::chrono::steady_clock::now() < deadline) {
            const auto snapshot = client.snapshot();
            if ((mode == "browse" || mode == "browse-revoke") && connected) {
                const auto page = client.listing();
                if (!page.error.empty()) { std::cerr << page.error << std::endl; return 1; }
                if (!page.loading && browse_stage == 0 && page.devices.size() == 1) {
                    if (page.devices[0].id != "mac-a" || !page.next_devices.empty()) return 1;
                    client.list_sessions("mac-a"); browse_stage = 1;
                } else if (!page.loading && browse_stage == 1 && page.device_id == "mac-a") {
                    if (page.sessions.size() != 20 || page.next_sessions != "session-19") return 1;
                    client.list_sessions("mac-a", page.next_sessions); browse_stage = 2;
                } else if (!page.loading && browse_stage == 2) {
                    if (page.sessions.size() != 5 || page.sessions.front().id != "session-20" || !page.next_sessions.empty()) return 1;
                    std::cout << "LISTED 25" << std::endl;
                    if (mode == "browse") return 0;
                    browse_stage = 3;
                }
            }
            if (connected && mode == "idle" && snapshot.state != connection::State::Connected) {
                std::cerr << "Unexpected disconnect while idle" << std::endl; return 1;
            }
            if (connected && mode == "timeout" && snapshot.state == connection::State::Retrying) {
                std::cout << "HEARTBEAT_TIMEOUT" << std::endl; return 0;
            }
            if (snapshot.state != last) {
                last = snapshot.state;
                if (last == connection::State::Waiting) std::cout << "WAITING" << std::endl;
                if (last == connection::State::Connected) {
                    connected = true; connected_at = std::chrono::steady_clock::now();
                    std::cout << "CONNECTED " << snapshot.device_count << std::endl;
                    if (mode == "connect") return 0;
                }
                if (last == connection::State::Revoked) {
                    const auto listing = client.listing();
                    if (!listing.devices.empty() || !listing.sessions.empty()) return 1;
                    std::cout << "REVOKED" << std::endl; return connected ? 0 : 1;
                }
                if (last == connection::State::Error || last == connection::State::Denied || last == connection::State::Expired) { std::cerr << snapshot.message << std::endl; return 1; }
            }
            if (connected && mode == "idle" && std::chrono::steady_clock::now() - connected_at >= std::chrono::seconds(90)) {
                std::cout << "IDLE_OK" << std::endl; return 0;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; }
    return 1;
}
