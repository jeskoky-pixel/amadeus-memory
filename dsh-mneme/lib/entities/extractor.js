const VALID_TYPES = new Set(["person", "group", "project", "concept", "technology", "organization"]);
const VALID_RELATIONS = new Set(["uses", "depends_on", "part_of", "related_to"]);
const MAX_MEMORY_CHARS = 4000;
// Hard ceiling for LLM-returned relations. Ten entities can produce at most 90
// distinct ordered pairs; 100 leaves a small duplicate margin and keeps normal
// extraction behavior unchanged.
const MAX_RELATIONS = 100;

function buildSystemPrompt(config) {
  const maxEntities = config.entityExtractionMaxEntities ?? 10;
  const maxAttrs = config.entityExtractionMaxAttrs ?? 20;
  
  return `You are an entity extraction engine. Extract named entities, their attributes, and relations from the given text.

RULES:
- Entities are concrete people, groups, projects, technologies, concepts, or organizations.
- Use type "group" for chat groups. A clearly identified QQ group number (QQ群<id>, QQ 群 <id>, 群<id>) is the group's stable identifier; the name may still include the number.
- Never treat a group as a person or merge two different group numbers. Different stable identifiers are different entities even when the display name is the same.
- Attributes are characteristic states of an entity. Only extract attributes explicitly mentioned in the text.
- Do NOT infer, guess, or hallucinate. Only extract what is clearly stated.
- Use canonical names (full name / primary name). Do NOT merge synonyms — different spellings of the same person are different entities.
- Output MUST be strict JSON with this exact structure:
{
  "entities": [
    {"name": "string", "type": "person|group|project|concept|technology|organization", "attrs": [{"key": "string", "value": "string", "confidence": 0.9}]}
  ],
  "relations": [
    {"from": "entityName", "to": "entityName", "type": "uses|depends_on|part_of|related_to"}
  ]
}

CONSTRAINTS:
- "type" must be one of: person, group, project, concept, technology, organization. If unsure, use "concept".
- "relations" from/to must reference entity names from the "entities" list.
- Maximum ${maxEntities} entities. Maximum ${maxAttrs} attributes per entity. Truncate if exceeded.
- Only include entity-related attributes. Ignore irrelevant miscellaneous details.
- Return ONLY the JSON object. No explanations, no markdown, no code fences.`;
}

function buildUserMessage(memoryText) {
  const truncated = memoryText.length > MAX_MEMORY_CHARS 
    ? memoryText.slice(0, MAX_MEMORY_CHARS) + "..." 
    : memoryText;
  return truncated;
}

function extractJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  
  // Try to find first {...} block
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  
  return null;
}

function sanitizeType(type) {
  if (VALID_TYPES.has(type)) return type;
  return "concept";
}

function sanitizeConfidence(conf) {
  const num = Number(conf);
  if (Number.isNaN(num)) return 0.9;
  return Math.min(1, Math.max(0, num));
}

function sanitizeRelationType(type) {
  if (VALID_RELATIONS.has(type)) return type;
  return "related_to";
}

function sanitizeExtractedData(data, config) {
  const maxEntities = config.entityExtractionMaxEntities ?? 10;
  const maxAttrs = config.entityExtractionMaxAttrs ?? 20;
  
  if (!data || !Array.isArray(data.entities)) {
    throw new Error("Invalid extraction: missing entities array");
  }
  
  const entities = [];
  const seenNames = new Set();
  
  for (const rawEntity of data.entities.slice(0, maxEntities)) {
    if (!rawEntity || typeof rawEntity.name !== "string" || !rawEntity.name.trim()) continue;
    
    const name = rawEntity.name.trim();
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    
    const attrs = [];
    if (Array.isArray(rawEntity.attrs)) {
      for (const rawAttr of rawEntity.attrs.slice(0, maxAttrs)) {
        if (!rawAttr || typeof rawAttr.key !== "string" || typeof rawAttr.value !== "string") continue;
        attrs.push({
          key: rawAttr.key.trim(),
          value: rawAttr.value.trim(),
          confidence: sanitizeConfidence(rawAttr.confidence)
        });
      }
    }
    
    entities.push({
      name,
      type: sanitizeType(rawEntity.type),
      attrs
    });
  }
  
  const relations = [];
  if (Array.isArray(data.relations)) {
    for (const rawRel of data.relations.slice(0, MAX_RELATIONS)) {
      if (!rawRel || typeof rawRel.from !== "string" || typeof rawRel.to !== "string") continue;
      if (!seenNames.has(rawRel.from) || !seenNames.has(rawRel.to)) continue;
      relations.push({
        from: rawRel.from,
        to: rawRel.to,
        type: sanitizeRelationType(rawRel.type)
      });
    }
  }
  
  return { entities, relations };
}

async function resolveEntity(entity, store, identity, evidence) {
  // Stable identity is the single resolver: typed external IDs first, then a
  // unique confirmed alias / name. Ambiguous same-name people are returned to
  // the caller as suggestions and are never silently merged by name.
  if (identity?.resolveEntityForWrite) {
    return identity.resolveEntityForWrite({
      name: entity.name,
      type: entity.type,
      actor: "entity_extractor",
      evidence
    });
  }
  const existing = store.findEntityByName(entity.name);
  if (existing) {
    store.updateEntity(existing.id, {});
    return { ok: true, entity: existing, canonical_id: existing.id, created: false, matched_by: "name" };
  }
  const created = store.createEntity({ name: entity.name, type: entity.type });
  return { ok: true, entity: created, canonical_id: created.id, created: true, matched_by: "new" };
}

export async function extractEntities(memory, { store, config, callLLM, logger, identity }) {
  try {
    if (!memory || !memory.content) {
      return { ok: false, error: "Invalid memory: missing content" };
    }
    
    const systemPrompt = buildSystemPrompt(config);
    const userText = buildUserMessage(memory.content);

    const messages = [
      { role: "system", content: [{ type: "text", text: systemPrompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: userText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ];

    // Issue #109: optional provider/model override + reasoning effort are
    // passed through to callLLM's options; the index.js adapter maps them onto
    // the route (or falls back to the caller's default model). Empty provider/
    // model both mean "use the caller default".
    const options = {};
    if (config.entityExtractionProvider) options.provider = config.entityExtractionProvider;
    if (config.entityExtractionModel) options.model = config.entityExtractionModel;
    const reasoning = config.entityExtractionReasoning;
    if (reasoning && reasoning !== "none") options.reasoningEffort = reasoning;
    // #405: 审计行要能归因到具体记忆。extractor 只把 content 写进 prompt，id 这里顺
    // options 交给 index.js 的 adapter（route 映射只认 provider/model，多余键不会进
    // llm.stream）。拿不到 id 就不写这个键，adapter 侧照旧留空数组，不造虚账。
    if (memory.id) options.memoryId = memory.id;
    const llmResponse = await callLLM(messages, options);
    
    if (!llmResponse) {
      return { ok: false, error: "LLM returned empty response" };
    }
    
    const rawData = extractJsonFromText(llmResponse);
    if (!rawData) {
      return { ok: false, error: "Failed to parse JSON from LLM response" };
    }
    
    const { entities, relations } = sanitizeExtractedData(rawData, config);
    
    const resolvedEntities = [];
    const unresolved = [];
    const unresolvedRaw = new Map();
    const entityIdMap = new Map();
    let skipCount = 0;

    // Resolve entities
    for (const entity of entities) {
      try {
        const resolution = await resolveEntity(entity, store, identity, [
          { kind: "memory", value: memory.id ?? null }
        ]);
        if (!resolution.ok) {
          // Ambiguous or name-only: keep the assertion durable as pending data,
          // never write attrs/relations against a guessed UUID.
          skipCount++;
          unresolvedRaw.set(entity.name, { entity, resolution });
          unresolved.push({
            name: entity.name,
            type: entity.type,
            reason: resolution.reason,
            candidates: (resolution.candidates ?? []).map((group) => ({
              id: group.id,
              name: group.name,
              type: group.type,
              member_ids: group.member_ids
            }))
          });
          logger?.warn?.(
            `[extractor] entity "${entity.name}" not resolved (${resolution.reason}); candidate confirmation required`
          );
          continue;
        }
        entityIdMap.set(entity.name, resolution.entity.id);
        resolvedEntities.push({ ...entity, entity_id: resolution.entity.id, canonical_id: resolution.canonical_id });
      } catch (err) {
        skipCount++;
        logger?.warn?.(`[extractor] Failed to resolve entity "${entity.name}":`, err.message);
      }
    }
    
    // Record attributes
    const attrs = [];
    for (const entity of resolvedEntities) {
      for (const attr of entity.attrs) {
        try {
          const saved = store.saveAttr({
            entity_id: entity.entity_id,
            attr_key: attr.key,
            attr_value: String(attr.value),
            memory_id: memory.id,
            confidence: attr.confidence,
            source: "llm_extract"
          });
          attrs.push(saved);
        } catch (err) {
          skipCount++;
          logger?.warn?.(`[extractor] Failed to save attr "${attr.key}" for entity "${entity.name}":`, err.message);
        }
      }
    }
    
    // Record relations. A relation with an unresolved endpoint is persisted as
    // a durable pending relation (not discarded), and is retried after human
    // confirmation of both ends. Existing rows for this memory are reused to
    // avoid duplicate edges on re-extraction.
    const savedRelations = [];
    const entityTypeByName = new Map(entities.map((entity) => [entity.name, entity.type]));
    const existingRelations = typeof store.getRelationsByMemory === "function"
      ? store.getRelationsByMemory(memory.id)
      : [];
    const relationKey = (from, to, type) => `${from}|${to}|${type}`;
    const existingByKey = new Map(existingRelations.map((rel) =>
      [relationKey(rel.from_entity, rel.to_entity, rel.relation_type), rel]
    ));
    for (const rel of relations) {
      const fromId = entityIdMap.get(rel.from);
      const toId = entityIdMap.get(rel.to);
      if (!fromId || !toId) {
        if (memory.id && identity?.recordPendingRelation) {
          try {
            identity.recordPendingRelation({
              memory_id: memory.id,
              from_name: rel.from,
              from_entity_id: fromId ?? null,
              from_entity_type: entityTypeByName.get(rel.from) ?? "",
              to_name: rel.to,
              to_entity_id: toId ?? null,
              to_entity_type: entityTypeByName.get(rel.to) ?? "",
              relation_type: rel.type,
              evidence: [{ kind: "memory", value: memory.id }]
            });
          } catch (err) {
            skipCount++;
            logger?.warn?.(`[extractor] Failed to persist pending relation "${rel.from} -> ${rel.to}":`, err.message);
          }
        }
        continue;
      }
      const key = relationKey(fromId, toId, rel.type);
      if (existingByKey.has(key)) {
        savedRelations.push(existingByKey.get(key));
        continue;
      }
      try {
        const saved = store.saveRelation({
          from_entity: fromId,
          to_entity: toId,
          relation_type: rel.type,
          memory_id: memory.id,
          metadata: { model: options.model || "default" },
          // issue #24 块2：LLM 抽取自动建边 → llm 来源（初值 0.4），区别于
          // 人工/确认的满权边。来源进 metadata 之上的独立列，演化与审计可辨。
          source: "llm"
        });
        savedRelations.push(saved);
        existingByKey.set(key, saved);
      } catch (err) {
        skipCount++;
        logger?.warn?.(`[extractor] Failed to save relation "${rel.from} -> ${rel.to}":`, err.message);
      }
    }
    
    // Persist unresolved name-only assertions together with their source
    // memory. Ambiguous candidates remain pending; a human confirmation (or an
    // explicit selection) can recover them later without re-running the LLM.
    // Relations live in identity_pending_relations so an unresolved other end
    // cannot be lost when this assertion's attributes are applied.
    if (memory.id && identity?.recordPendingAssertion) {
      for (const entry of unresolved) {
        const raw = unresolvedRaw.get(entry.name);
        if (!raw) continue;
        try {
          const pending = identity.recordPendingAssertion({
            memory_id: memory.id,
            display_name: entry.name,
            entity_type: entry.type,
            attrs: raw.entity.attrs,
            relations: [],
            candidates: raw.resolution.candidates ?? [],
            evidence: [
              { kind: "memory", value: memory.id },
              { kind: "extraction", value: raw.resolution.reason ?? "unresolved" }
            ]
          });
          if (pending) entry.pending_id = pending.id;
        } catch (err) {
          logger?.warn?.(`[extractor] Failed to persist pending assertion for "${entry.name}":`, err.message);
        }
      }
    }

    return {
      ok: true,
      entities: resolvedEntities,
      attrs,
      relations: savedRelations,
      unresolved,
      skipped: skipCount
    };
    
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
