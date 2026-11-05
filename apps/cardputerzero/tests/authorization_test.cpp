#include "authorization.h"
#include "linux_input.h"
#include <cassert>
#include <iostream>
#include <filesystem>
#include <sys/stat.h>
#include <unistd.h>

int main() {
    assert(platform::map_keyboard_key(19, false) == 'r');
    assert(platform::map_keyboard_key(18, true) == 'E');
    assert(platform::map_keyboard_key(52, false) == '.');
    assert(platform::map_keyboard_key(12, false) == '-');
    assert(platform::map_keyboard_key(39, true) == ':');
    assert(platform::map_keyboard_key(15, false) == LV_KEY_NEXT);
    assert(platform::map_keyboard_key(15, true) == LV_KEY_PREV);
    assert(platform::map_keyboard_key(14, false) == LV_KEY_BACKSPACE);
    assert(platform::map_keyboard_key(0xffff, false) == 0);
    assert(connection::normalize_origin("example.com") == "https://example.com");
    assert(connection::normalize_origin("https://example.com:443/") == "https://example.com");
    for (const auto* invalid : {"http://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com?token=secret", "https://example.com#fragment", "http://127.0.0.1:8000"}) {
        bool rejected = false;
        try { connection::normalize_origin(invalid); } catch (...) { rejected = true; }
        assert(rejected);
    }
    assert(connection::normalize_origin("http://127.0.0.1:8000", true) == "http://127.0.0.1:8000");
    char temporary[] = "/tmp/termrelay-auth-test-XXXXXX";
    const auto* path = mkdtemp(temporary);
    assert(path);
    { connection::Authorization client(path); assert(!client.snapshot().has_credential); }
    struct stat info{};
    assert(stat(path, &info) == 0 && (info.st_mode & 0777) == 0700);
    const auto file = std::filesystem::path(path) / "authorization.json";
    assert(stat(file.c_str(), &info) == 0 && (info.st_mode & 0777) == 0600);
    { connection::Authorization client(path); assert(!client.snapshot().has_credential); }
    chmod(file.c_str(), 0644);
    bool rejected = false;
    try { connection::Authorization client(path); } catch (...) { rejected = true; }
    assert(rejected);
    std::filesystem::remove(file);
    std::filesystem::create_symlink("/etc/hosts", file);
    rejected = false;
    try { connection::Authorization client(path); } catch (...) { rejected = true; }
    assert(rejected);
    std::filesystem::remove_all(path);
    std::cout << "Origin and private credential storage checks passed\n";
}