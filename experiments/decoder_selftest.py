import struct
from bike_trainer import ftms as F

# Set Target Power 250 W
assert F.set_target_power(250) == bytes([0x05, 0xFA, 0x00]), F.set_target_power(250).hex(' ')
assert F.set_target_power(300).hex(' ') == "05 2c 01"
print("set_target_power(250) =", F.set_target_power(250).hex(' '))
print("set_target_power(300) =", F.set_target_power(300).hex(' '))

# Control point response
r = F.parse_control_response(bytes([0x80, 0x00, 0x01]))
print("resp:", r, "| ok =", r.ok)
r2 = F.parse_control_response(bytes([0x80, 0x05, 0x05]))
print("resp:", r2, "| ok =", r2.ok)

# Indoor Bike Data: flags = speed + cadence + power
# bit0 clear -> speed present; bit2 cadence; bit6 power
flags = (1 << 2) | (1 << 6)
frame = struct.pack("<HHHh", flags, 3000, 180, 247)   # 30.00 kph, 90 rpm, 247 W
d = F.parse_indoor_bike_data(frame)
print(f"bike: speed={d.speed_kph} kph cadence={d.cadence_rpm} rpm power={d.power_w} W")
assert (d.speed_kph, d.cadence_rpm, d.power_w) == (30.0, 90.0, 247)

# Feature: power target (bit3) + sim (bit13) set in word 2
feat = F.parse_machine_feature(struct.pack("<II", (1<<1)|(1<<14), (1<<3)|(1<<13)))
print("machine:", feat.machine)
print("targets:", feat.targets)
assert feat.supports_opcode(0x05) and feat.supports_opcode(0x11)
assert not feat.supports_opcode(0x04)

# Status
s = F.parse_machine_status(bytes([0x08, 0x2C, 0x01]))
print("status:", s)
assert s.value == 300

# Power range
print("range:", F.parse_power_range(struct.pack("<hhH", 0, 2000, 1)))
print("\nALL DECODER SELF-TESTS PASSED")
