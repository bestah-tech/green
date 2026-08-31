// 최소 JSON 스키마 검증기
// 외부 라이브러리 없이 type / required / properties / items / enum / minItems 만 지원한다.
// LLM 응답 검증용이므로 통과/실패와 사람이 읽을 수 있는 오류 목록만 있으면 충분하다.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "object" | "string" | "number" | "boolean"
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "integer") return actual === "number" && Number.isInteger(value);
  return actual === expected;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;

  // type: 문자열 또는 배열(["string","null"] 등)
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: 타입이 ${types.join("|")} 이어야 하는데 ${typeOf(value)} 입니다.`);
      return; // 타입이 틀리면 하위 검증은 의미 없음
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 허용값(${schema.enum.join(", ")}) 중 하나여야 합니다. 현재: ${JSON.stringify(value)}`);
  }

  if (typeOf(value) === "object") {
    const required = schema.required || [];
    required.forEach((key) => {
      if (!(key in value)) errors.push(`${path}.${key}: 필수 항목이 없습니다.`);
    });
    const props = schema.properties || {};
    Object.keys(props).forEach((key) => {
      if (key in value) validateNode(value[key], props[key], `${path}.${key}`, errors);
    });
  }

  if (typeOf(value) === "array") {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path}: 항목이 최소 ${schema.minItems}개 필요합니다. 현재 ${value.length}개.`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors));
    }
  }
}

// 반환: { ok: boolean, errors: string[] }
export function validateSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "$", errors);
  return { ok: errors.length === 0, errors };
}
