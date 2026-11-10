// Generated-file boundary. Replace this bootstrap with schema code generation.
export type ProtocolVersion = '2';

export interface Envelope<TPayload = Record<string, unknown>> {
  type: string;
  protocolVersion: ProtocolVersion;
  messageId: string;
  deviceId: string;
  sessionId?: string;
  commandId?: string;
  seq?: number;
  sentAt: string;
  payload: TPayload;
}

export interface DeviceRegisterPayload {
  name: string;
  appVersion: string;
  platform: "macOS" | "linux";
  tools: string[];
  chatAttachments?: boolean;
}

export interface DeviceRegisteredPayload {
  registeredAt: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export interface DeviceHeartbeatPayload {
  connectionState: 'connected' | 'degraded';
  activeSessionCount?: number;
}

export interface WorkspaceRegisteredPayload {
  workspaceId: string;
  displayName: string;
  available: boolean;
  remoteStartAllowed: boolean;
  launchOptions?: { toolKey: string; runtimeMode: SessionRuntimeMode }[];
}

export type SessionRuntimeMode = 'pty' | 'acp';

export interface SessionStartPayload {
  workspaceId: string;
  toolKey: string;
  runtimeMode: SessionRuntimeMode;
  rows?: number;
  columns?: number;
  displayName?: string;
}

export interface SessionStartedPayload {
  workspaceId: string;
  toolKey: string;
  displayName?: string;
  runtimeMode: SessionRuntimeMode;
  startedAt: string;
  origin?: 'local' | 'external';
  projectId?: string;
  aiResourceId?: string;
}

export interface SessionEndedPayload {
  status: 'finished' | 'failed';
  finishedAt: string;
}

export type SessionSyncPayload = Record<string, never>;

export interface SessionSyncedPayload {
  lastAcceptedSeq: number;
}

export type ProtocolErrorCode =
  | 'invalid_message'
  | 'unsupported_version'
  | 'unknown_device'
  | 'unknown_session'
  | 'unauthorized_workspace'
  | 'conflict'
  | 'internal_error';

export interface ProtocolErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  relatedMessageId?: string;
  expectedSeq?: number;
}

// Runtime schema exports are generated-file artifacts derived from the JSON Schema source.
export const envelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/envelope.schema.json',
  title: 'TermRelay message envelope',
  type: 'object',
  required: ['type', 'protocolVersion', 'messageId', 'deviceId', 'sentAt', 'payload'],
  properties: {
    type: { type: 'string', minLength: 1 },
    protocolVersion: { const: '2' },
    messageId: { type: 'string', format: 'uuid' },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
    sessionId: { type: 'string', minLength: 1, maxLength: 128 },
    commandId: { type: 'string', format: 'uuid' },
    seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sentAt: { type: 'string', format: 'date-time' },
    payload: { type: 'object' },
  },
  additionalProperties: false,
} as const;

export const deviceRegisterSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/device-register.schema.json",
  "title": "device.register payload",
  "type": "object",
  "required": [
    "name",
    "appVersion",
    "platform",
    "tools"
  ],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "appVersion": {
      "type": "string",
      "minLength": 1
    },
    "platform": {
      "enum": [
        "macOS",
        "linux"
      ]
    },
    "chatAttachments": {
      "type": "boolean"
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "uniqueItems": true
    }
  },
  "additionalProperties": false
} as const;

export const deviceHeartbeatSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/device-heartbeat.schema.json',
  title: 'device.heartbeat payload',
  type: 'object',
  required: ['connectionState'],
  properties: {
    connectionState: { enum: ['connected', 'degraded'] },
    activeSessionCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

export const workspaceRegisteredSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/workspace-registered.schema.json",
  "title": "workspace.registered payload",
  "type": "object",
  "required": [
    "workspaceId",
    "displayName",
    "available",
    "remoteStartAllowed"
  ],
  "properties": {
    "workspaceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
    },
    "available": {
      "type": "boolean"
    },
    "remoteStartAllowed": {
      "type": "boolean"
    },
    "launchOptions": {
      "type": "array",
      "maxItems": 16,
      "uniqueItems": true,
      "items": {
        "type": "object",
        "required": [
          "toolKey",
          "runtimeMode"
        ],
        "properties": {
          "toolKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "runtimeMode": {
            "enum": [
              "pty",
              "acp"
            ]
          }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
} as const;

export const sessionStartedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-started.schema.json",
  "title": "session.started payload",
  "type": "object",
  "required": [
    "workspaceId",
    "toolKey",
    "runtimeMode",
    "startedAt"
  ],
  "properties": {
    "workspaceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "toolKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "runtimeMode": {
      "enum": [
        "pty",
        "acp"
      ]
    },
    "startedAt": {
      "type": "string",
      "format": "date-time"
    },
    "origin": {
      "enum": [
        "local",
        "external"
      ]
    },
    "projectId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "aiResourceId": {
      "type": "string",
      "format": "uuid"
    }
  },
  "additionalProperties": false
} as const;

export const sessionEndedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/session-ended.schema.json',
  title: 'session.ended payload',
  type: 'object',
  required: ['status', 'finishedAt'],
  properties: {
    status: { enum: ['finished', 'failed'] },
    finishedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

export const sessionSyncSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/session-sync.schema.json',
  title: 'session.sync payload',
  type: 'object',
  maxProperties: 0,
  additionalProperties: false,
} as const;

export const sessionSyncedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/session-synced.schema.json',
  title: 'session.synced payload',
  type: 'object',
  required: ['lastAcceptedSeq'],
  properties: {
    lastAcceptedSeq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
  additionalProperties: false,
} as const;

export interface TerminalOutputPayload {
  encoding: 'base64';
  data: string;
}

export interface ToolEventCorrelation {
  turnId?: string;
  itemId?: string;
  approvalId?: string;
}

export type ToolEventKind = "turn.started" | "user.message" | "assistant.delta" | "assistant.completed" | "reasoning.delta" | "command.started" | "command.output" | "command.completed" | "file.changed" | "approval.requested" | "approval.resolved" | "user-input.requested" | "user-input.resolved" | "plan.updated" | "turn.completed" | "config.updated" | "warning" | "error";

export interface ToolEventPayload {
  kind: ToolEventKind;
  occurredAt: string;
  correlation: ToolEventCorrelation;
  data: Record<string, unknown>;
}

export interface ToolTurnStartPayload {
  text: string;
  attachments?: string[];
}
export type ToolTurnInterruptPayload = Record<string, never>;
export interface ToolApprovalResolvePayload {
  approvalId: string;
  turnId: string;
  decision: 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel';
}
export interface ToolUserInputResolvePayload {
  requestId: string;
  turnId: string;
  answers: Record<string, string[]>;
}

export interface TerminalInputPayload {
  encoding: 'base64';
  data: string;
}

export interface TerminalResizePayload {
  columns: number;
  rows: number;
}

export type SessionInterruptPayload = Record<string, never>;
export type SessionStopPayload = Record<string, never>;

export interface SessionSubscribePayload {
  afterSeq?: number;
}

export type SessionUnsubscribePayload = Record<string, never>;

export const terminalOutputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/terminal-output.schema.json',
  title: 'terminal.output payload',
  type: 'object',
  required: ['encoding', 'data'],
  properties: {
    encoding: { const: 'base64' },
    data: {
      type: 'string',
      minLength: 4,
      maxLength: 1_398_104,
      contentEncoding: 'base64',
      pattern:
        '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    },
  },
  additionalProperties: false,
} as const;

export const toolEventSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/tool-event.schema.json",
  "title": "tool.event payload",
  "type": "object",
  "required": [
    "kind",
    "occurredAt",
    "correlation",
    "data"
  ],
  "properties": {
    "kind": {
      "enum": [
        "turn.started",
        "user.message",
        "assistant.delta",
        "assistant.completed",
        "reasoning.delta",
        "command.started",
        "command.output",
        "command.completed",
        "file.changed",
        "approval.requested",
        "approval.resolved",
        "user-input.requested",
        "user-input.resolved",
        "plan.updated",
        "turn.completed",
        "config.updated",
        "warning",
        "error"
      ]
    },
    "occurredAt": {
      "type": "string",
      "format": "date-time"
    },
    "correlation": {
      "type": "object",
      "properties": {
        "turnId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "itemId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "approvalId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        }
      },
      "additionalProperties": false
    },
    "data": {
      "type": "object"
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "kind": {
            "const": "config.updated"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "options"
            ],
            "properties": {
              "options": {
                "type": "array",
                "maxItems": 16,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "name",
                    "currentValue",
                    "choices"
                  ],
                  "properties": {
                    "id": {
                      "enum": [
                        "model",
                        "effort"
                      ]
                    },
                    "name": {
                      "type": "string",
                      "maxLength": 128
                    },
                    "currentValue": {
                      "type": "string",
                      "maxLength": 128
                    },
                    "choices": {
                      "type": "array",
                      "maxItems": 200,
                      "items": {
                        "type": "object",
                        "required": [
                          "value",
                          "name"
                        ],
                        "properties": {
                          "value": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128
                          },
                          "name": {
                            "type": "string",
                            "maxLength": 128
                          }
                        },
                        "additionalProperties": false
                      }
                    }
                  },
                  "additionalProperties": false
                }
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "enum": [
              "assistant.delta",
              "assistant.completed",
              "reasoning.delta",
              "plan.updated"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "text"
            ],
            "properties": {
              "text": {
                "type": "string",
                "maxLength": 1048576
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "command.output"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "commandId",
              "text"
            ],
            "properties": {
              "commandId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "text": {
                "type": "string",
                "maxLength": 1048576
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "turn.started"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "turnId"
            ],
            "properties": {
              "turnId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "command.started"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "commandId",
              "command"
            ],
            "properties": {
              "commandId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "command": {
                "type": "string",
                "minLength": 1,
                "maxLength": 65536
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "command.completed"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "commandId"
            ],
            "properties": {
              "commandId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "exitCode": {
                "type": [
                  "integer",
                  "null"
                ]
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "file.changed"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "itemId",
              "summary"
            ],
            "properties": {
              "itemId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "approval.requested"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "approvalId",
              "turnId",
              "kind",
              "risk",
              "title",
              "availableDecisions",
              "expiresAt"
            ],
            "properties": {
              "approvalId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "turnId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "itemId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "kind": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64
              },
              "risk": {
                "enum": [
                  "low",
                  "medium",
                  "high",
                  "critical"
                ]
              },
              "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "detail": {
                "type": "string",
                "maxLength": 65536
              },
              "availableDecisions": {
                "type": "array",
                "minItems": 1,
                "uniqueItems": true,
                "items": {
                  "enum": [
                    "allowOnce",
                    "allowSession",
                    "allowPolicy",
                    "deny",
                    "cancel"
                  ]
                }
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time"
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "turn.completed"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "turnId",
              "status"
            ],
            "properties": {
              "turnId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "status": {
                "enum": [
                  "completed",
                  "interrupted",
                  "failed"
                ]
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "approval.resolved"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "approvalId",
              "turnId",
              "decision"
            ],
            "properties": {
              "approvalId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "turnId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "decision": {
                "enum": [
                  "allowOnce",
                  "allowSession",
                  "allowPolicy",
                  "deny",
                  "cancel"
                ]
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "enum": [
              "warning",
              "error"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "code",
              "message"
            ],
            "properties": {
              "code": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "message": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              }
            },
            "additionalProperties": false
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "kind": {
            "const": "user.message"
          }
        }
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "required": [
              "messageId",
              "text"
            ],
            "properties": {
              "messageId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "text": {
                "type": "string",
                "maxLength": 65536
              },
              "attachments": {
                "type": "array",
                "maxItems": 8,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "name",
                    "mimeType",
                    "size"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "format": "uuid"
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "mimeType": {
                      "enum": [
                        "image/png",
                        "image/jpeg",
                        "image/webp",
                        "application/pdf",
                        "text/plain",
                        "text/markdown"
                      ]
                    },
                    "size": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 20971520
                    }
                  },
                  "additionalProperties": false
                }
              }
            },
            "additionalProperties": false
          }
        }
      }
    }
  ],
  "additionalProperties": false
} as const;

export const toolConfigSetSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/tool-config-set.schema.json",
  "title": "tool.config.set payload",
  "type": "object",
  "required": [
    "id",
    "value"
  ],
  "properties": {
    "id": {
      "enum": [
        "model",
        "effort"
      ]
    },
    "value": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  },
  "additionalProperties": false
} as const;

export const toolTurnStartSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/tool-turn-start.schema.json",
  "title": "tool.turn.start payload",
  "type": "object",
  "required": [
    "text"
  ],
  "properties": {
    "text": {
      "type": "string",
      "maxLength": 65536
    },
    "attachments": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "format": "uuid"
      }
    }
  },
  "additionalProperties": false,
  "anyOf": [
    {
      "properties": {
        "text": {
          "minLength": 1,
          "type": "string"
        }
      }
    },
    {
      "required": [
        "attachments"
      ],
      "properties": {
        "attachments": {
          "minItems": 1,
          "type": "array"
        }
      }
    }
  ]
} as const;

export const toolTurnInterruptSchema = {
  type: 'object', maxProperties: 0, additionalProperties: false,
} as const;

export const toolApprovalResolveSchema = {
  type: 'object', required: ['approvalId', 'turnId', 'decision'],
  properties: {
    approvalId: { type: 'string', minLength: 1, maxLength: 256 },
    turnId: { type: 'string', minLength: 1, maxLength: 256 },
    decision: { enum: ['allowOnce', 'allowSession', 'allowPolicy', 'deny', 'cancel'] },
  },
  additionalProperties: false,
} as const;

export const toolUserInputResolveSchema = {
  type: 'object', required: ['requestId', 'turnId', 'answers'],
  properties: {
    requestId: { type: 'string', minLength: 1, maxLength: 256 },
    turnId: { type: 'string', minLength: 1, maxLength: 256 },
    answers: {
      type: 'object', minProperties: 1,
      additionalProperties: { type: 'array', minItems: 1, items: { type: 'string', maxLength: 65_536 } },
    },
  },
  additionalProperties: false,
} as const;

export const sessionStartSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/session-start.schema.json",
  "title": "session.start payload",
  "type": "object",
  "required": [
    "workspaceId",
    "toolKey",
    "runtimeMode"
  ],
  "properties": {
    "workspaceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "toolKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "runtimeMode": {
      "enum": [
        "pty",
        "acp"
      ]
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "rows": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "columns": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    }
  },
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "runtimeMode": {
            "const": "pty"
          }
        }
      },
      "then": {
        "properties": {
          "rows": true,
          "columns": true
        },
        "required": [
          "rows",
          "columns"
        ]
      },
      "else": {
        "properties": {
          "rows": false,
          "columns": false
        }
      }
    }
  ]
} as const;

export const terminalInputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/commands/terminal-input.schema.json',
  title: 'terminal.input payload',
  type: 'object',
  required: ['encoding', 'data'],
  properties: {
    encoding: { const: 'base64' },
    data: {
      type: 'string',
      minLength: 4,
      maxLength: 87_384,
      contentEncoding: 'base64',
      pattern:
        '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    },
  },
  additionalProperties: false,
} as const;

export const terminalResizeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/commands/terminal-resize.schema.json',
  title: 'terminal.resize payload',
  type: 'object',
  required: ['columns', 'rows'],
  properties: {
    columns: { type: 'integer', minimum: 1, maximum: 1_000 },
    rows: { type: 'integer', minimum: 1, maximum: 1_000 },
  },
  additionalProperties: false,
} as const;

export const sessionInterruptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/commands/session-interrupt.schema.json',
  title: 'session.interrupt payload',
  type: 'object',
  maxProperties: 0,
  additionalProperties: false,
} as const;

export const sessionStopSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/commands/session-stop.schema.json',
  title: 'session.stop payload',
  type: 'object',
  maxProperties: 0,
  additionalProperties: false,
} as const;

export const sessionSubscribeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/web/session-subscribe.schema.json',
  title: 'session.subscribe payload',
  type: 'object',
  properties: {
    afterSeq: {
      type: 'integer',
      minimum: -1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  additionalProperties: false,
} as const;

export const sessionUnsubscribeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/web/session-unsubscribe.schema.json',
  title: 'session.unsubscribe payload',
  type: 'object',
  maxProperties: 0,
  additionalProperties: false,
} as const;

export type CommandStatus = 'accepted' | 'completed' | 'rejected' | 'failed';

export interface CommandAckPayload {
  commandId: string;
  status: CommandStatus;
  errorCode?: string;
  message?: string;
}

export const commandAckSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/commands/command-ack.schema.json',
  title: 'command.ack payload',
  type: 'object',
  required: ['commandId', 'status'],
  properties: {
    commandId: { type: 'string', format: 'uuid' },
    status: { enum: ['accepted', 'completed', 'rejected', 'failed'] },
    errorCode: { type: 'string' },
    message: { type: 'string', maxLength: 2_048 },
  },
  additionalProperties: false,
} as const;
export interface SessionHistoryListPayload {
  scope?: 'copilot' | 'external';
  cursor?: string;
}

export interface SessionHistoryEntry {
  projectId?: string | null;
  id: string;
  workspaceId: string;
  toolKey: string;
  displayName: string | null;
  runtimeMode: 'acp';
  status: 'starting' | 'running' | 'stopping' | 'finished' | 'failed';
  startedAt: string | null;
  updatedAt: string;
}

export interface SessionHistoryListedPayload {
  sessions: SessionHistoryEntry[];
  hasMore: boolean;
  relatedMessageId: string;
  nextCursor?: string;
}

export interface SessionHistoryRequestPayload {
  beforeSeq?: number;
  limit?: number;
}

export interface SessionHistoryEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SessionHistoryPayload {
  events: SessionHistoryEvent[];
  hasMore: boolean;
  relatedMessageId: string;
}

export interface SessionHistoryDeletePayload {
  purge: boolean;
}

export interface SessionHistoryDeletedPayload {
  purged: boolean;
  relatedMessageId: string;
}

export const sessionHistoryListSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-history-list.schema.json",
  "title": "session.history.list payload",
  "type": "object",
  "properties": {
    "cursor": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1024,
      "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"
    },
    "scope": {
      "enum": [
        "copilot",
        "external"
      ]
    }
  },
  "additionalProperties": false
} as const;

export const sessionHistoryListedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-history-listed.schema.json",
  "title": "session.history.listed payload",
  "type": "object",
  "required": [
    "sessions",
    "hasMore",
    "relatedMessageId"
  ],
  "properties": {
    "sessions": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "object",
        "required": [
          "id",
          "workspaceId",
          "toolKey",
          "displayName",
          "runtimeMode",
          "status",
          "startedAt",
          "updatedAt"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "workspaceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "toolKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "displayName": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 128
          },
          "runtimeMode": {
            "const": "acp"
          },
          "status": {
            "enum": [
              "starting",
              "running",
              "stopping",
              "finished",
              "failed"
            ]
          },
          "startedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time"
          },
          "projectId": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 128
          }
        },
        "additionalProperties": false
      }
    },
    "hasMore": {
      "type": "boolean"
    },
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    },
    "nextCursor": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1024,
      "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"
    }
  },
  "additionalProperties": false
} as const;

export const sessionHistoryRequestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-history-request.schema.json",
  "title": "session.history.request payload",
  "type": "object",
  "properties": {
    "beforeSeq": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50
    }
  },
  "additionalProperties": false
} as const;

export const sessionHistorySchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-history.schema.json",
  "title": "session.history payload",
  "type": "object",
  "required": [
    "events",
    "hasMore",
    "relatedMessageId"
  ],
  "properties": {
    "events": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "required": [
          "seq",
          "type",
          "payload",
          "createdAt"
        ],
        "properties": {
          "seq": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "type": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "payload": {
            "type": "object"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "additionalProperties": false
      }
    },
    "hasMore": {
      "type": "boolean"
    },
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    }
  },
  "additionalProperties": false
} as const;

export const sessionHistoryDeleteSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-history-delete.schema.json",
  "title": "session.history.delete payload",
  "type": "object",
  "required": [
    "purge"
  ],
  "properties": {
    "purge": {
      "type": "boolean"
    }
  },
  "additionalProperties": false
} as const;

export const sessionHistoryDeletedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/session-history-deleted.schema.json",
  "title": "session.history.deleted payload",
  "type": "object",
  "required": [
    "purged",
    "relatedMessageId"
  ],
  "properties": {
    "purged": {
      "type": "boolean"
    },
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    }
  },
  "additionalProperties": false
} as const;

export interface ShortcutCatalogEntry {
  id: string;
  revision: number;
  name: string;
  description: string;
  workspaceId: string;
  proxyMode: 'inherit' | 'disabled' | 'custom';
  requiresConfirmation: boolean;
}

export interface ShortcutCatalogPayload {
  shortcuts: ShortcutCatalogEntry[];
}

export interface ShortcutRunUpdatePayload {
  runId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  exitCode?: number;
  output?: string;
}

export interface ShortcutRunStartPayload {
  runId: string;
  shortcutId: string;
  revision: number;
}

export interface ShortcutRunCancelPayload {
  runId: string;
}

export interface ShortcutRunInputPayload {
  runId: string;
  commandId: string;
  answer: 'y' | 'n' | 'yes' | 'no';
}

export interface ShortcutRunInputAckPayload {
  runId: string;
  commandId: string;
  status: 'accepted' | 'rejected';
  message?: string;
}

export const shortcutCatalogSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/shortcut-catalog.schema.json",
  "title": "shortcut.catalog payload",
  "type": "object",
  "required": [
    "shortcuts"
  ],
  "properties": {
    "shortcuts": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "object",
        "required": [
          "id",
          "revision",
          "name",
          "description",
          "workspaceId",
          "proxyMode",
          "requiresConfirmation"
        ],
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "revision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "description": {
            "type": "string",
            "maxLength": 2048
          },
          "workspaceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "proxyMode": {
            "enum": [
              "inherit",
              "disabled",
              "custom"
            ]
          },
          "requiresConfirmation": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
} as const;

export const shortcutRunUpdateSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/shortcut-run-update.schema.json",
  "title": "shortcut.run.update payload",
  "type": "object",
  "required": [
    "runId",
    "status"
  ],
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "enum": [
        "running",
        "succeeded",
        "failed",
        "cancelled"
      ]
    },
    "exitCode": {
      "type": "integer",
      "minimum": -2147483648,
      "maximum": 2147483647
    },
    "output": {
      "type": "string",
      "maxLength": 32768
    }
  },
  "additionalProperties": false
} as const;

export const shortcutRunStartSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/shortcut-run-start.schema.json",
  "title": "shortcut.run.start payload (server to Mac)",
  "type": "object",
  "required": [
    "runId",
    "shortcutId",
    "revision"
  ],
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid"
    },
    "shortcutId": {
      "type": "string",
      "format": "uuid"
    },
    "revision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    }
  },
  "additionalProperties": false
} as const;

export const shortcutRunCancelSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/shortcut-run-cancel.schema.json",
  "title": "shortcut.run.cancel payload (server to Mac)",
  "type": "object",
  "required": [
    "runId"
  ],
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid"
    }
  },
  "additionalProperties": false
} as const;

export const shortcutRunInputSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/shortcut-run-input.schema.json",
  "title": "shortcut.run.input payload",
  "type": "object",
  "required": [
    "runId",
    "commandId",
    "answer"
  ],
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid"
    },
    "commandId": {
      "type": "string",
      "format": "uuid"
    },
    "answer": {
      "enum": [
        "y",
        "n",
        "yes",
        "no"
      ]
    }
  },
  "additionalProperties": false
} as const;

export const shortcutRunInputAckSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/shortcut-run-input-ack.schema.json",
  "title": "shortcut.run.input.ack payload",
  "type": "object",
  "required": [
    "runId",
    "commandId",
    "status"
  ],
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid"
    },
    "commandId": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "enum": [
        "accepted",
        "rejected"
      ]
    },
    "message": {
      "type": "string",
      "maxLength": 2048
    }
  },
  "additionalProperties": false
} as const;

export interface ControllerConversationPayload { op: "sync" | "ready" | "history" | "requests" | "event" | "command" | "status" | "close"; sessionId: string; syncId?: string; beforeSeq?: number; seq?: number; offset?: number; commandId?: string; type?: string; data?: Record<string, unknown>; reviewToken?: string; }
export interface ControllerDeviceSummary {
  id: string; name: string; status: "connected" | "connecting" | "offline" | "degraded"; platform: "macOS" | "linux";
}
export interface ControllerSessionSummary {
  id: string; deviceId: string; workspaceId: string; toolKey: string; displayName: string | null;
  runtimeMode: "acp" | "pty"; status: "starting" | "running" | "stopping" | "finished" | "failed";
}
export interface ControllerDevicesListPayload { cursor?: string; limit?: number; }
export interface ControllerSessionsListPayload extends ControllerDevicesListPayload { deviceId: string; }
export interface ControllerDevicesListedPayload { relatedMessageId: string; items: ControllerDeviceSummary[]; nextCursor: string | null; }
export interface ControllerSessionsListedPayload { relatedMessageId: string; deviceId: string; items: ControllerSessionSummary[]; nextCursor: string | null; }
export interface AttachmentMetadata {
  id: string; name: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "text/plain" | "text/markdown"; size: number;
}
export interface AttachmentRequestPayload {
  requestId: string; workspaceId: string; operation: "upload" | "read" | "delete" | "purge"; attachmentId: string; offset: number;
  attachment?: AttachmentMetadata; data?: string; final?: boolean;
}
export interface AttachmentResultPayload {
  requestId: string; status: "ok" | "error"; attachment?: AttachmentMetadata; data?: string; message?: string;
}

export interface FilePreviewRequestPayload {
  requestId: string;
  workspaceId: string;
  path: string;
}

export interface FilePreviewResultPayload {
  requestId: string;
  status: 'ok' | 'not_found' | 'forbidden' | 'too_large' | 'unsupported' | 'error';
  name?: string;
  content?: string;
}

export const controllerConversationSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/controller-conversation.schema.json",
  "title": "Controller conversation request",
  "oneOf": [
    {
      "type": "object",
      "required": [
        "op",
        "sessionId"
      ],
      "properties": {
        "op": {
          "const": "sync"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId"
      ],
      "properties": {
        "op": {
          "const": "close"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId"
      ],
      "properties": {
        "op": {
          "const": "ready"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId",
        "beforeSeq"
      ],
      "properties": {
        "op": {
          "const": "history"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "beforeSeq": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId"
      ],
      "properties": {
        "op": {
          "const": "requests"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "beforeSeq": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId",
        "seq",
        "offset"
      ],
      "properties": {
        "op": {
          "const": "event"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "seq": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "offset": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "commandId"
      ],
      "properties": {
        "op": {
          "const": "status"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "commandId": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId",
        "commandId",
        "type",
        "data"
      ],
      "properties": {
        "op": {
          "const": "command"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "commandId": {
          "type": "string",
          "format": "uuid"
        },
        "type": {
          "const": "tool.turn.start"
        },
        "data": {
          "type": "object",
          "required": [
            "text"
          ],
          "properties": {
            "text": {
              "type": "string",
              "maxLength": 16384
            }
          },
          "additionalProperties": false,
          "anyOf": [
            {
              "properties": {
                "text": {
                  "minLength": 1,
                  "type": "string"
                }
              }
            },
            {
              "required": [
                "attachments"
              ],
              "properties": {
                "attachments": {
                  "minItems": 1,
                  "type": "array"
                }
              }
            }
          ]
        },
        "reviewToken": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId",
        "commandId",
        "type",
        "data"
      ],
      "properties": {
        "op": {
          "const": "command"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "commandId": {
          "type": "string",
          "format": "uuid"
        },
        "type": {
          "const": "tool.turn.interrupt"
        },
        "data": {
          "type": "object",
          "maxProperties": 0,
          "additionalProperties": false
        },
        "reviewToken": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId",
        "commandId",
        "type",
        "data"
      ],
      "properties": {
        "op": {
          "const": "command"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "commandId": {
          "type": "string",
          "format": "uuid"
        },
        "type": {
          "const": "tool.approval.resolve"
        },
        "data": {
          "type": "object",
          "required": [
            "approvalId",
            "turnId",
            "decision"
          ],
          "properties": {
            "approvalId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "turnId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "decision": {
              "enum": [
                "allowOnce",
                "deny",
                "cancel"
              ]
            }
          },
          "additionalProperties": false
        },
        "reviewToken": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "op",
        "sessionId",
        "syncId",
        "commandId",
        "type",
        "data"
      ],
      "properties": {
        "op": {
          "const": "command"
        },
        "sessionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "syncId": {
          "type": "string",
          "format": "uuid"
        },
        "commandId": {
          "type": "string",
          "format": "uuid"
        },
        "type": {
          "const": "tool.user-input.resolve"
        },
        "data": {
          "type": "object",
          "required": [
            "requestId",
            "turnId",
            "answers"
          ],
          "properties": {
            "requestId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "turnId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "answers": {
              "type": "object",
              "minProperties": 1,
              "additionalProperties": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "type": "string",
                  "maxLength": 4096
                },
                "maxItems": 32
              },
              "maxProperties": 32
            }
          },
          "additionalProperties": false
        },
        "reviewToken": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    }
  ]
} as const;

export const controllerConversationResultSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/controller-conversation-result.schema.json",
  "title": "Controller conversation response",
  "type": "object",
  "required": [
    "op",
    "sessionId",
    "body"
  ],
  "properties": {
    "op": {
      "enum": [
        "sync",
        "ready",
        "history",
        "requests",
        "event",
        "command",
        "status",
        "close",
        "events",
        "resync",
        "ack"
      ]
    },
    "sessionId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    },
    "body": {
      "type": "object"
    }
  },
  "additionalProperties": false,
  "$defs": {
    "event": {
      "type": "object",
      "required": [
        "seq",
        "type",
        "createdAt",
        "bytes",
        "payload"
      ],
      "properties": {
        "seq": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "type": {
          "type": "string",
          "maxLength": 64
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": [
            "object",
            "null"
          ]
        },
        "reviewToken": {
          "type": "string",
          "format": "uuid"
        }
      },
      "additionalProperties": false
    }
  },
  "oneOf": [
    {
      "properties": {
        "op": {
          "const": "sync"
        },
        "body": {
          "type": "object",
          "required": [
            "syncId",
            "boundary",
            "session",
            "canWrite",
            "items",
            "beforeSeq"
          ],
          "properties": {
            "syncId": {
              "type": "string",
              "format": "uuid"
            },
            "boundary": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "session": {
              "type": "object",
              "required": [
                "id",
                "deviceId",
                "workspaceId",
                "toolKey",
                "displayName",
                "runtimeMode",
                "status"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "deviceId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "workspaceId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "toolKey": {
                  "type": "string",
                  "maxLength": 64
                },
                "displayName": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 128
                },
                "runtimeMode": {
                  "enum": [
                    "acp",
                    "pty"
                  ]
                },
                "status": {
                  "enum": [
                    "starting",
                    "running",
                    "stopping",
                    "finished",
                    "failed"
                  ]
                }
              },
              "additionalProperties": false
            },
            "canWrite": {
              "type": "boolean"
            },
            "items": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "$ref": "#/$defs/event"
              }
            },
            "beforeSeq": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "ready"
        },
        "body": {
          "type": "object",
          "required": [
            "syncId"
          ],
          "properties": {
            "syncId": {
              "type": "string",
              "format": "uuid"
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "history"
        },
        "body": {
          "type": "object",
          "required": [
            "syncId",
            "items",
            "beforeSeq"
          ],
          "properties": {
            "syncId": {
              "type": "string",
              "format": "uuid"
            },
            "items": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "$ref": "#/$defs/event"
              }
            },
            "beforeSeq": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "requests"
        },
        "body": {
          "type": "object",
          "required": [
            "syncId",
            "items",
            "beforeSeq"
          ],
          "properties": {
            "syncId": {
              "type": "string",
              "format": "uuid"
            },
            "items": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "$ref": "#/$defs/event"
              }
            },
            "beforeSeq": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "event"
        },
        "body": {
          "type": "object",
          "required": [
            "syncId",
            "seq",
            "offset",
            "total",
            "data",
            "final"
          ],
          "properties": {
            "syncId": {
              "type": "string",
              "format": "uuid"
            },
            "seq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "offset": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "total": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "data": {
              "type": "string",
              "maxLength": 32768,
              "pattern": "^[A-Za-z0-9+/]*={0,2}$"
            },
            "final": {
              "type": "boolean"
            },
            "reviewToken": {
              "type": "string",
              "format": "uuid"
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "command"
        },
        "body": {
          "type": "object",
          "required": [
            "commandId",
            "dispatched"
          ],
          "properties": {
            "commandId": {
              "type": "string",
              "format": "uuid"
            },
            "dispatched": {
              "const": true
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "status"
        },
        "body": {
          "type": "object",
          "required": [
            "commandId",
            "ack"
          ],
          "properties": {
            "commandId": {
              "type": "string",
              "format": "uuid"
            },
            "ack": {
              "anyOf": [
                {
                  "type": "object",
                  "required": [
                    "commandId",
                    "status"
                  ],
                  "properties": {
                    "commandId": {
                      "type": "string",
                      "format": "uuid"
                    },
                    "status": {
                      "enum": [
                        "accepted",
                        "completed",
                        "rejected",
                        "failed"
                      ]
                    },
                    "errorCode": {
                      "type": "string"
                    },
                    "message": {
                      "type": "string",
                      "maxLength": 2048
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "close"
        },
        "body": {
          "type": "object",
          "required": [],
          "properties": {},
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "events"
        },
        "body": {
          "type": "object",
          "required": [
            "syncId",
            "items",
            "throughSeq",
            "session",
            "canWrite",
            "requestsChanged"
          ],
          "properties": {
            "syncId": {
              "type": "string",
              "format": "uuid"
            },
            "items": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "$ref": "#/$defs/event"
              }
            },
            "throughSeq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "session": {
              "type": "object",
              "required": [
                "id",
                "deviceId",
                "workspaceId",
                "toolKey",
                "displayName",
                "runtimeMode",
                "status"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "deviceId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "workspaceId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "toolKey": {
                  "type": "string",
                  "maxLength": 64
                },
                "displayName": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 128
                },
                "runtimeMode": {
                  "enum": [
                    "acp",
                    "pty"
                  ]
                },
                "status": {
                  "enum": [
                    "starting",
                    "running",
                    "stopping",
                    "finished",
                    "failed"
                  ]
                }
              },
              "additionalProperties": false
            },
            "canWrite": {
              "type": "boolean"
            },
            "requestsChanged": {
              "type": "boolean"
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "resync"
        },
        "body": {
          "type": "object",
          "required": [
            "reason"
          ],
          "properties": {
            "reason": {
              "const": "buffer_or_history_gap"
            }
          },
          "additionalProperties": false
        }
      }
    },
    {
      "properties": {
        "op": {
          "const": "ack"
        },
        "body": {
          "type": "object",
          "required": [
            "commandId",
            "ack"
          ],
          "properties": {
            "commandId": {
              "type": "string",
              "format": "uuid"
            },
            "ack": {
              "type": "object",
              "required": [
                "commandId",
                "status"
              ],
              "properties": {
                "commandId": {
                  "type": "string",
                  "format": "uuid"
                },
                "status": {
                  "enum": [
                    "accepted",
                    "completed",
                    "rejected",
                    "failed"
                  ]
                },
                "errorCode": {
                  "type": "string"
                },
                "message": {
                  "type": "string",
                  "maxLength": 2048
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        }
      }
    }
  ]
} as const;

export const controllerDevicesListSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/controller-devices-list.schema.json",
  "title": "controller-devices-list.schema payload",
  "type": "object",
  "required": [],
  "properties": {
    "cursor": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    }
  },
  "additionalProperties": false
} as const;

export const controllerSessionsListSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/controller-sessions-list.schema.json",
  "title": "controller-sessions-list.schema payload",
  "type": "object",
  "required": [
    "deviceId"
  ],
  "properties": {
    "cursor": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    },
    "deviceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  },
  "additionalProperties": false
} as const;

export const controllerDevicesListedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/controller-devices-listed.schema.json",
  "title": "controller-devices-listed.schema payload",
  "type": "object",
  "required": [
    "relatedMessageId",
    "items",
    "nextCursor"
  ],
  "properties": {
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    },
    "items": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "required": [
          "id",
          "name",
          "status",
          "platform"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "name": {
            "type": "string",
            "maxLength": 128
          },
          "status": {
            "enum": [
              "connected",
              "connecting",
              "offline",
              "degraded"
            ]
          },
          "platform": {
            "enum": [
              "macOS",
              "linux"
            ]
          }
        },
        "additionalProperties": false
      }
    },
    "nextCursor": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
    }
  },
  "additionalProperties": false
} as const;

export const controllerSessionsListedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/controller-sessions-listed.schema.json",
  "title": "controller-sessions-listed.schema payload",
  "type": "object",
  "required": [
    "relatedMessageId",
    "items",
    "nextCursor",
    "deviceId"
  ],
  "properties": {
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    },
    "items": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "required": [
          "id",
          "deviceId",
          "workspaceId",
          "toolKey",
          "displayName",
          "runtimeMode",
          "status"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "deviceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "workspaceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "toolKey": {
            "type": "string",
            "maxLength": 64
          },
          "displayName": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 128
          },
          "runtimeMode": {
            "enum": [
              "acp",
              "pty"
            ]
          },
          "status": {
            "enum": [
              "starting",
              "running",
              "stopping",
              "finished",
              "failed"
            ]
          }
        },
        "additionalProperties": false
      }
    },
    "nextCursor": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
    },
    "deviceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  },
  "additionalProperties": false
} as const;

export const controllerMeGetSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/controller-me-get.schema.json",
  "title": "controller.me.get payload",
  "type": "object",
  "additionalProperties": false
} as const;

export const controllerConnectedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/controller-connected.schema.json",
  "title": "controller.connected payload",
  "type": "object",
  "required": [
    "role",
    "installationId",
    "deviceIds",
    "permissions",
    "expiresAt"
  ],
  "properties": {
    "relatedMessageId": {
      "type": "string",
      "format": "uuid"
    },
    "capabilities": {
      "type": "array",
      "maxItems": 3,
      "uniqueItems": true,
      "items": {
        "enum": [
          "devices.list",
          "sessions.list",
          "conversation"
        ]
      }
    },
    "role": {
      "const": "controller"
    },
    "installationId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "deviceIds": {
      "type": "array",
      "maxItems": 100,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "permissions": {
      "type": "array",
      "items": {
        "enum": [
          "sessions.read",
          "turns.write",
          "approvals.resolve",
          "user-input.resolve"
        ]
      }
    },
    "expiresAt": {
      "type": "null"
    }
  },
  "additionalProperties": false
} as const;

export const controllerAuthorizationRevokedSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/controller-authorization-revoked.schema.json",
  "title": "controller.authorization-revoked payload",
  "type": "object",
  "required": [
    "reason",
    "revokedAt"
  ],
  "properties": {
    "reason": {
      "const": "revoked"
    },
    "revokedAt": {
      "type": "string",
      "format": "date-time"
    }
  },
  "additionalProperties": false
} as const;

export const attachmentRequestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/attachment-request.schema.json",
  "title": "attachment.request payload",
  "type": "object",
  "required": [
    "requestId",
    "workspaceId",
    "operation",
    "attachmentId",
    "offset"
  ],
  "properties": {
    "requestId": {
      "type": "string",
      "format": "uuid"
    },
    "workspaceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "operation": {
      "enum": [
        "upload",
        "read",
        "delete",
        "purge"
      ]
    },
    "attachmentId": {
      "type": "string",
      "format": "uuid"
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "maximum": 20971520
    },
    "attachment": {
      "type": "object",
      "required": [
        "id",
        "name",
        "mimeType",
        "size"
      ],
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "mimeType": {
          "enum": [
            "image/png",
            "image/jpeg",
            "image/webp",
            "application/pdf",
            "text/plain",
            "text/markdown"
          ]
        },
        "size": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20971520
        }
      },
      "additionalProperties": false
    },
    "data": {
      "type": "string",
      "maxLength": 262144,
      "pattern": "^[A-Za-z0-9+/]*={0,2}$"
    },
    "final": {
      "type": "boolean"
    }
  },
  "additionalProperties": false
} as const;

export const attachmentResultSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/attachment-result.schema.json",
  "title": "attachment.result payload",
  "type": "object",
  "required": [
    "requestId",
    "status"
  ],
  "properties": {
    "requestId": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "enum": [
        "ok",
        "error"
      ]
    },
    "attachment": {
      "type": "object",
      "required": [
        "id",
        "name",
        "mimeType",
        "size"
      ],
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "mimeType": {
          "enum": [
            "image/png",
            "image/jpeg",
            "image/webp",
            "application/pdf",
            "text/plain",
            "text/markdown"
          ]
        },
        "size": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20971520
        }
      },
      "additionalProperties": false
    },
    "data": {
      "type": "string",
      "maxLength": 262144,
      "pattern": "^[A-Za-z0-9+/]*={0,2}$"
    },
    "message": {
      "type": "string",
      "maxLength": 512
    }
  },
  "additionalProperties": false
} as const;

export const filePreviewRequestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/commands/file-preview-request.schema.json",
  "title": "file.preview.request payload",
  "type": "object",
  "required": [
    "requestId",
    "workspaceId",
    "path"
  ],
  "properties": {
    "requestId": {
      "type": "string",
      "format": "uuid"
    },
    "workspaceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    }
  },
  "additionalProperties": false
} as const;

export const filePreviewResultSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://termrelay.local/contracts/events/file-preview-result.schema.json",
  "title": "file.preview.result payload",
  "type": "object",
  "required": [
    "requestId",
    "status"
  ],
  "properties": {
    "requestId": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "enum": [
        "ok",
        "not_found",
        "forbidden",
        "too_large",
        "unsupported",
        "error"
      ]
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
    },
    "content": {
      "type": "string",
      "maxLength": 524288
    }
  },
  "if": {
    "properties": {
      "status": {
        "const": "ok"
      }
    }
  },
  "then": {
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 255
      },
      "content": {
        "type": "string",
        "maxLength": 524288
      }
    },
    "required": [
      "name",
      "content"
    ]
  },
  "else": {
    "properties": {
      "name": false,
      "content": false
    }
  },
  "additionalProperties": false
} as const;
export * from "./ai.js";
