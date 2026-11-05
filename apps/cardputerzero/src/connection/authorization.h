#pragma once
#include <memory>
#include <string>

namespace connection {
enum class State { Idle, Starting, Waiting, Connecting, Connected, Retrying, Denied, Expired, Revoked, Error };
struct Snapshot {
    State state = State::Idle;
    std::string origin;
    std::string message;
    unsigned device_count = 0;
    bool has_credential = false;
};
std::string normalize_origin(const std::string& input, bool allow_test_loopback = false);
std::string default_state_directory();
class Authorization {
public:
    explicit Authorization(std::string directory = default_state_directory(), bool allow_test_loopback = false);
    ~Authorization();
    Authorization(const Authorization&) = delete;
    Authorization& operator=(const Authorization&) = delete;
    void connect(const std::string& origin);
    void cancel();
    void forget();
    Snapshot snapshot() const;
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
}