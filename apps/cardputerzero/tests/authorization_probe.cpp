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
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
        while (std::chrono::steady_clock::now() < deadline) {
            const auto snapshot = client.snapshot();
            if (snapshot.state != last) {
                last = snapshot.state;
                if (last == connection::State::Waiting) std::cout << "WAITING" << std::endl;
                if (last == connection::State::Connected) {
                    connected = true; std::cout << "CONNECTED " << snapshot.device_count << std::endl;
                    if (std::string(argv[3]) == "connect") return 0;
                }
                if (last == connection::State::Revoked) { std::cout << "REVOKED" << std::endl; return connected ? 0 : 1; }
                if (last == connection::State::Error || last == connection::State::Denied || last == connection::State::Expired) { std::cerr << snapshot.message << std::endl; return 1; }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; }
    return 1;
}