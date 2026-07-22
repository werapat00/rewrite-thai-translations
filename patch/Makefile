CROSS ?= i686-w64-mingw32
CC := $(CROSS)-gcc

MINHOOK_DIR ?= /opt/minhook
MINHOOK_SRCS := $(MINHOOK_DIR)/src/buffer.c \
                $(MINHOOK_DIR)/src/hook.c \
                $(MINHOOK_DIR)/src/trampoline.c \
                $(MINHOOK_DIR)/src/hde/hde32.c
MINHOOK_INC := $(MINHOOK_DIR)/include

OUT ?= dist
CFLAGS := -O2 -Wall -municode -I$(MINHOOK_INC) -Isrc

.PHONY: all clean
all: $(OUT)/hook.dll $(OUT)/launcher.exe

$(OUT):
	mkdir -p $(OUT)

$(OUT)/hook.dll: src/hook_dll.c $(MINHOOK_SRCS) | $(OUT)
	$(CC) $(CFLAGS) -shared -o $@ $^ -lgdi32

$(OUT)/launcher.exe: src/launcher.c | $(OUT)
	$(CC) $(CFLAGS) -mwindows -o $@ $^

clean:
	rm -rf $(OUT)
