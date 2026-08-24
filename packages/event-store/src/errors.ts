export class EventScopeMismatchError extends Error {
  constructor() {
    super("event scope does not match the bound channel");
    this.name = "EventScopeMismatchError";
  }
}

export class EventSequenceConflictError extends Error {
  constructor() {
    super("event sequence does not match the stream version");
    this.name = "EventSequenceConflictError";
  }
}

export class EventConflictError extends Error {
  constructor() {
    super("event id already exists with different content");
    this.name = "EventConflictError";
  }
}

export class CommandConflictError extends Error {
  constructor() {
    super("command id already exists with different content");
    this.name = "CommandConflictError";
  }
}

export class ProjectionVersionConflictError extends Error {
  constructor() {
    super("projection version does not match the stored version");
    this.name = "ProjectionVersionConflictError";
  }
}

export class ProjectionSourceEventNotFoundError extends Error {
  constructor() {
    super("projection source event does not exist at the supplied sequence");
    this.name = "ProjectionSourceEventNotFoundError";
  }
}

export class TerminalEventConflictError extends Error {
  constructor() {
    super("Run stream already contains a terminal event");
    this.name = "TerminalEventConflictError";
  }
}

export class ChannelSessionConflictError extends Error {
  constructor() {
    super("channel scope already belongs to another ChannelSession");
    this.name = "ChannelSessionConflictError";
  }
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(version: number, currentVersion = 1) {
    super(`Unsupported schema version ${version}; current version is ${currentVersion}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class ScheduleConflictError extends Error {
  constructor() {
    super("schedule identity already exists with different content");
    this.name = "ScheduleConflictError";
  }
}

export class ScheduleNotificationConflictError extends Error {
  constructor() {
    super("schedule notification identity already exists with different content");
    this.name = "ScheduleNotificationConflictError";
  }
}
