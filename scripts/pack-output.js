function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function selectPackDetails(output, packageName) {
  let details;

  if (Array.isArray(output)) {
    if (output.length !== 1) {
      throw new Error(`npm pack returned ${output.length} package entries; expected exactly one.`);
    }
    [details] = output;
  } else if (isObject(output)) {
    const packageNames = Object.keys(output);
    if (packageNames.length !== 1 || packageNames[0] !== packageName) {
      throw new Error(`npm pack returned unexpected package keys: ${packageNames.join(', ') || '(none)'}.`);
    }
    details = output[packageName];
  } else {
    throw new Error('npm pack returned an unsupported JSON shape.');
  }

  if (!isObject(details) || details.name !== packageName) {
    throw new Error(`npm pack metadata does not describe ${packageName}.`);
  }
  if (!Array.isArray(details.files)) {
    throw new Error('npm pack metadata is missing its file list.');
  }
  if (!Number.isInteger(details.entryCount) || details.entryCount < 0) {
    throw new Error('npm pack metadata has an invalid entry count.');
  }
  if (!Number.isFinite(details.size) || details.size < 0) {
    throw new Error('npm pack metadata has an invalid packed size.');
  }

  return details;
}
