import json
import sys

def validate(config):
    if not isinstance(config, dict):
        return False
    return 'plugin' in config

if __name__ == '__main__':
    with open(sys.argv[1], 'r') as f:
        result = validate(json.load(f))
    print('valid' if result else 'invalid')
