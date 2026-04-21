// Seed blackboard.json with TC1 (Rust) inputs for smoke testing agent-1.
// Usage: node smoke-seed.js
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = __dirname;
const WORKSPACE = path.join(ROOT, 'workspace');
const BLACKBOARD = path.join(WORKSPACE, 'blackboard.json');
const FIXTURES = path.join(ROOT, 'fixtures');

const material = fs.readFileSync(path.join(FIXTURES, 'rust-material.md'), 'utf-8');
const dimsYaml = yaml.load(fs.readFileSync(path.join(FIXTURES, 'rust-dimensions.yaml'), 'utf-8'));

const board = {
  workflow: {
    current_step: 0,
    total_steps: 4,
    steps: ['agent_1', 'agent_2', 'agent_3', 'agent_4'],
    status: 'pending',
  },
  user_input: {
    material: { filename: 'rust-material.md', content: material, content_type: 'markdown' },
    competency_dimensions: dimsYaml.dimensions,
    domain_guidance: null,
    assessment_params: dimsYaml.assessment_params,
  },
  data: {
    knowledge_units: null,
    mapping: null,
    items: null,
    review: null,
  },
  log: [],
  costs: { total_usd: 0, by_agent: {} },
};

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(BLACKBOARD, JSON.stringify(board, null, 2));
console.log(`seeded blackboard.json (material ${material.length} chars, ${dimsYaml.dimensions.length} dimensions)`);
