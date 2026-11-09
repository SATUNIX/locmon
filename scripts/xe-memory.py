#!/usr/bin/env python3
"""Read-only Xe memory-region query. Python stdlib bridges the DRM ioctl.

ABI: /usr/include/drm/xe_drm.h, drm_xe_device_query + drm_xe_mem_region.
No allocation, device configuration, privileged metrics, or third-party modules.
"""
import ctypes
import fcntl
import json
import os
import struct
import sys


def query_memory(path):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        # _IOWR('d', DRM_COMMAND_BASE + 0, struct drm_xe_device_query).
        request = (3 << 30) | (40 << 16) | (ord('d') << 8) | 0x40
        query = bytearray(struct.pack('=QIIQQQ', 0, 1, 0, 0, 0, 0))
        fcntl.ioctl(fd, request, query, True)
        size = struct.unpack_from('=I', query, 12)[0]
        if not 8 <= size <= 1024 * 1024:
            raise ValueError('Invalid memory-region query size')
        data = ctypes.create_string_buffer(size)
        query = bytearray(struct.pack('=QIIQQQ', 0, 1, size, ctypes.addressof(data), 0, 0))
        fcntl.ioctl(fd, request, query, True)
        count = struct.unpack_from('=I', data.raw)[0]
        if 8 + count * 88 > size:
            raise ValueError('Truncated memory-region query')
        total, used = 0, 0
        for index in range(count):
            mem_class, _, _, region_total, region_used = struct.unpack_from('=HHIQQ', data.raw, 8 + index * 88)
            if mem_class == 1:
                total += region_total
                used += region_used
        return {'total': total, 'used': used, 'source': 'Xe memory regions'}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        print(json.dumps(query_memory(sys.argv[1])))
    except (OSError, ValueError, IndexError) as error:
        print(json.dumps({'total': None, 'used': None, 'error': str(error)}))
