# QuickPreview Makefile 测试样本
CC      ?= gcc
CFLAGS  := -O2 -Wall
TARGET  := quickpreview-demo

all: $(TARGET)

$(TARGET): main.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f $(TARGET)

.PHONY: all clean
