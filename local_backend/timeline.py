"""Map a saved extended cut back to its unchanged source timeline."""
from copy import deepcopy


def output_to_source(value, insertions):
    offset = 0.0
    for pause in sorted(insertions, key=lambda item: item['output_start']):
        if value < pause['output_start']:
            break
        if value < pause['output_end']:
            return pause['source_time']
        offset += pause['duration']
    return max(0.0, value - offset)


def cues_to_source(cues, insertions):
    result = []
    for cue in cues:
        item = deepcopy(cue)
        item['start'] = output_to_source(cue['start'], insertions)
        item['end'] = output_to_source(cue['end'], insertions)
        if item['end'] > item['start']:
            result.append(item)
    return result
