({
  size: 'size',
  maxFileSize: 'size',
  avoid: { array: 'string', required: false },
  placements: {
    array: {
      schema: {
        name: 'string',
        ext: { array: 'string', required: false },
      },
    },
    required: false,
  },
  sab: {
    schema: {
      limit: 'size',
      baseSegmentSize: 'size',
    },
    required: false,
  },
});
