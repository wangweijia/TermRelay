#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <dirent.h>
#include <sys/prctl.h>
#endif

static volatile sig_atomic_t stopping = 0;
static void stop(int sig) { (void)sig; stopping = 1; }

static int terminate_owned(pid_t child, int sig) {
#ifdef __linux__
    struct entry { pid_t pid, parent; int owned; };
    struct entry *entries = NULL;
    size_t count = 0;
    DIR *directory = opendir("/proc");
    if (!directory) return -1;
    struct dirent *item;
    while ((item = readdir(directory))) {
        char *end;
        long pid = strtol(item->d_name, &end, 10);
        if (!pid || *end) continue;
        char path[128], line[8192];
        snprintf(path, sizeof(path), "/proc/%ld/stat", pid);
        FILE *file = fopen(path, "r");
        if (!file) {
            if (errno == ENOENT || errno == ESRCH || errno == EACCES) continue;
            closedir(directory); free(entries); return -1;
        }
        size_t size = fread(line, 1, sizeof(line) - 1, file);
        int read_error = ferror(file) ? errno : 0;
        fclose(file);
        if (!size && (read_error == 0 || read_error == ENOENT || read_error == ESRCH)) continue;
        line[size] = '\0';
        char *tail = size ? strrchr(line, ')') : NULL;
        char state; int parent;
        if (!tail || sscanf(tail + 1, " %c %d", &state, &parent) != 2) {
            closedir(directory); free(entries); return -1;
        }
        struct entry *next = realloc(entries, (count + 1) * sizeof(*entries));
        if (!next) { closedir(directory); free(entries); return -1; }
        entries = next;
        entries[count++] = (struct entry){(pid_t)pid, (pid_t)parent, parent == getpid()};
    }
    closedir(directory);
    int changed;
    do {
        changed = 0;
        for (size_t i = 0; i < count; i++) {
            if (entries[i].owned) continue;
            for (size_t j = 0; j < count; j++) {
                if (entries[j].owned && entries[i].parent == entries[j].pid) {
                    entries[i].owned = 1; changed = 1; break;
                }
            }
        }
    } while (changed);
    int result = 0;
    for (size_t i = 0; i < count; i++) {
        if (!entries[i].owned) continue;
        if (kill(entries[i].pid, sig)) {
            if (errno != ESRCH) { result = -1; break; }
        } else result++;
    }
    free(entries);
    (void)child;
    return result;
#else
    if (kill(-child, sig) && errno != ESRCH) return -1;
    return 0;
#endif
}

static int lock_mode(const char *path, int check) {
    int fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) { perror("Agent lock"); return 1; }
    struct stat info;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid()) {
        fprintf(stderr, "Invalid Agent lock owner/type\n"); close(fd); return 1;
    }
    if (flock(fd, LOCK_EX | LOCK_NB)) {
        int result = errno == EWOULDBLOCK ? 2 : 1;
        close(fd); return result;
    }
    if (!check) {
        puts("locked"); fflush(stdout);
        struct pollfd input = {STDIN_FILENO, POLLIN, 0};
        while (!stopping) {
            int ready = poll(&input, 1, 100);
            if (ready < 0 && errno != EINTR) { close(fd); return 1; }
            if (ready > 0) {
                char data[128];
                if (read(STDIN_FILENO, data, sizeof(data)) <= 0) break;
            }
        }
    }
    close(fd); return 0;
}

int main(int argc, char **argv) {
    signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
#ifdef __linux__
    pid_t parent = getppid();
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGTERM)) {
        perror("Agent process ownership"); return 1;
    }
    if (getppid() != parent) stopping = 1;
#endif
    if (argc == 3 && (!strcmp(argv[1], "--lock") || !strcmp(argv[1], "--lock-check"))) {
        return lock_mode(argv[2], !strcmp(argv[1], "--lock-check"));
    }
    if (argc < 2 || stopping) return 1;
    int input[2];
    if (pipe(input)) { perror("Agent pipe"); return 1; }
    pid_t child = fork();
    if (child < 0) { perror("Agent fork"); return 1; }
    if (!child) {
        close(input[1]);
        if (setsid() < 0 || dup2(input[0], STDIN_FILENO) < 0) _exit(126);
        close(input[0]);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        execvp(argv[1], argv + 1);
        perror("Agent exec"); _exit(127);
    }
    close(input[0]);
    fcntl(input[1], F_SETFL, O_NONBLOCK);
    const size_t capacity = 2 * 1024 * 1024;
    char *buffer = malloc(capacity);
    size_t length = 0;
    int status = 0, reaped = 0, failed = !buffer;
    while (!stopping && !failed) {
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) { reaped = 1; break; }
        if (result < 0 && errno != EINTR) { failed = 1; break; }
        struct pollfd fds[2] = {
            {STDIN_FILENO, length < capacity ? POLLIN : 0, 0},
            {input[1], length ? POLLOUT : 0, 0}
        };
        int ready = poll(fds, 2, 100);
        if (ready < 0) { if (errno == EINTR) continue; failed = 1; break; }
        if (fds[0].revents & (POLLIN | POLLHUP)) {
            ssize_t size = read(STDIN_FILENO, buffer + length, capacity - length);
            if (!size) break;
            if (size < 0) { if (errno == EINTR) continue; failed = 1; break; }
            length += (size_t)size;
        }
        if (fds[1].revents & POLLOUT) {
            ssize_t size = write(input[1], buffer, length);
            if (size < 0) {
                if (errno == EAGAIN || errno == EINTR) continue;
                failed = 1; break;
            }
            length -= (size_t)size;
            memmove(buffer, buffer + size, length);
        }
        if (fds[1].revents & (POLLERR | POLLHUP)) break;
    }
    free(buffer); close(input[1]);
    if (terminate_owned(child, SIGTERM) < 0) failed = 1;
    usleep(200000);
    if (terminate_owned(child, SIGKILL) < 0) failed = 1;
    if (!reaped) {
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    }
    int remaining = 0;
    for (int attempt = 0; attempt < 20; attempt++) {
        while (waitpid(-1, NULL, WNOHANG) > 0) {}
        remaining = terminate_owned(child, SIGKILL);
        if (remaining <= 0) break;
        usleep(50000);
    }
    if (remaining != 0) failed = 1;
    if (failed) { fprintf(stderr, "Agent supervisor/ownership cleanup failed\n"); return 1; }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
