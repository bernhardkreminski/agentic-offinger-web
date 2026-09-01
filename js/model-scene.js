// Builds and maintains the three.js scene for one BTLX document.
// Mirrors ModelScene.swift and ModelSceneView.swift.
//
// BTLX is millimetre based and Z-up; three.js wants metres and Y-up. Both conversions live
// on a single orientation group so part meshes keep their original BTLX transform and stay
// directly comparable with the numbers shown in the inspector.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { boundsCentre, boundsSize } from './btlx-parser.js';
import { edgeGeometry, solidGeometry } from './geometry-factory.js';
import { buildDimensionOverlay, disposeOverlay } from './dimension-overlay.js';

/** Metres per millimetre. */
const UNIT_SCALE = 0.001;

/**
 * Standard shop-drawing viewpoints, expressed in the element's own frame rather than in
 * world axes: `offset` weights [horizontal, normal, vertical]. A wall rotated in plan is
 * therefore still viewed square-on, and for an axis-aligned element these reduce exactly
 * to the world-axis directions.
 */
export const VIEW_PRESETS = {
  iso: { label: 'Iso', offset: [-0.75, 1, 0.55] },
  // A shop-drawing elevation is a parallel projection: no perspective, no visible depth.
  front: { label: 'Ansicht', offset: [0, 1, 0], flat: true },
  back: { label: 'Rückseite', offset: [0, -1, 0] },
  top: { label: 'Draufsicht', offset: [0, 0, 1], upAlongNormal: true },
  side: { label: 'Seitlich', offset: [1, 0, 0] },
};

/** BTLX is Z-up, three.js is Y-up: (x, y, z) -> (x, z, -y). */
function toScene(v) {
  return new THREE.Vector3(v[0], v[2], -v[1]);
}

/** Camera offset direction and up vector for a preset, in scene space. */
function presetVectors(preset, frame) {
  const [h, n, v] = preset.offset;
  const direction = toScene([
    frame.horizontal[0] * h + frame.normal[0] * n + frame.vertical[0] * v,
    frame.horizontal[1] * h + frame.normal[1] * n + frame.vertical[1] * v,
    frame.horizontal[2] * h + frame.normal[2] * n + frame.vertical[2] * v,
  ]).normalize();

  // Looking straight down the element, "up" cannot be the vertical any more.
  const up = preset.upAlongNormal
    ? toScene(frame.normal).multiplyScalar(-1).normalize()
    : toScene(frame.vertical).normalize();

  return { direction, up };
}

export class ModelScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.doc = null;
    this.partMeshes = new Map(); // part id -> Mesh
    this.edgeMeshes = new Map();
    this.dimensionGroup = null;
    this.dimensionKey = null;
    this.needsRender = true;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.perspectiveCamera = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
    this.perspectiveCamera.position.set(4, 3, -6);
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 500);
    this.camera = this.perspectiveCamera;
    /** Camera-space extent the flat view was fitted to, kept so resizing can re-fit. */
    this.orthoFit = null;

    this.controls = this.makeControls(this.camera);

    this.orientation = new THREE.Group();
    // -X rotation by 90° maps BTLX (x, y, z) to scene (x, z, -y): Z-up becomes Y-up.
    this.orientation.rotation.x = -Math.PI / 2;
    this.orientation.scale.setScalar(UNIT_SCALE);
    this.centering = new THREE.Group();
    this.orientation.add(this.centering);
    this.scene.add(this.orientation);

    this.buildLighting();

    this.raycaster = new THREE.Raycaster();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();

    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      if (this.controls.enableDamping) this.controls.update();
      if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    tick();
  }

  requestRender() {
    this.needsRender = true;
  }

  makeControls(camera) {
    const controls = new OrbitControls(camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.addEventListener('change', () => this.requestRender());
    return controls;
  }

  /**
   * OrbitControls binds to one camera, so switching projection means rebuilding it.
   * The orbit target is carried across so the view does not jump.
   */
  useCamera(camera, flat) {
    if (this.camera !== camera) {
      const target = this.controls.target.clone();
      this.controls.dispose();
      this.camera = camera;
      this.controls = this.makeControls(camera);
      this.controls.target.copy(target);
    }
    // A flat elevation stays flat: pan and zoom only, no orbiting out of the plane.
    this.controls.enableRotate = !flat;
  }

  get aspect() {
    const parent = this.canvas.parentElement;
    return Math.max(parent.clientWidth, 1) / Math.max(parent.clientHeight, 1);
  }

  buildLighting() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.55));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-0.6, 1.0, -0.9);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.95);
    fill.position.set(0.8, 0.4, 0.7);
    this.scene.add(fill);
  }

  resize() {
    const parent = this.canvas.parentElement;
    const width = Math.max(parent.clientWidth, 1);
    const height = Math.max(parent.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    this.applyOrthoFrustum(width / height);
    this.requestRender();
  }

  // MARK: - Loading

  load(doc) {
    this.clear();
    this.doc = doc;

    const centre = boundsCentre(doc.bounds);
    this.centering.position.set(-centre[0], -centre[1], -centre[2]);

    for (const part of doc.parts) {
      const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...part.xAxis),
        new THREE.Vector3(...part.yAxis),
        new THREE.Vector3(...part.zAxis),
      );
      basis.setPosition(new THREE.Vector3(...part.origin));

      const geometry = solidGeometry(part.mesh);
      if (geometry) {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(...this.layerColour(part)),
          roughness: 0.85,
          metalness: 0,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(basis);
        mesh.userData.partID = part.id;
        this.centering.add(mesh);
        this.partMeshes.set(part.id, mesh);

        const edges = edgeGeometry(part.mesh);
        if (edges) {
          const edgeMesh = new THREE.LineSegments(
            edges,
            new THREE.LineBasicMaterial({ color: 0x212121, depthWrite: false }),
          );
          edgeMesh.matrixAutoUpdate = false;
          edgeMesh.matrix.copy(basis);
          edgeMesh.renderOrder = 10;
          this.centering.add(edgeMesh);
          this.edgeMeshes.set(part.id, edgeMesh);
        }
      }
    }
    this.requestRender();
  }

  clear() {
    for (const mesh of [...this.partMeshes.values(), ...this.edgeMeshes.values()]) {
      this.centering.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.partMeshes.clear();
    this.edgeMeshes.clear();
    this.removeDimensions();
    this.doc = null;
  }

  layerColour(part) {
    const layer = this.doc.layers.find((candidate) => candidate.id === part.layerID);
    if (layer) return layer.colour;
    if (part.colour) return part.colour.slice(0, 3);
    return [0.72, 0.72, 0.72];
  }

  // MARK: - Display

  apply(state) {
    if (!this.doc) return;
    const frame = this.doc.frame;
    const range = this.doc.frameBounds.n;
    const centreN = (range[0] + range[1]) / 2;
    const thickness = Math.max(range[1] - range[0], 1);
    const size = boundsSize(this.doc.bounds);
    const spread = Math.max(size[0], size[1], size[2]) * 0.35;

    for (const part of this.doc.parts) {
      const mesh = this.partMeshes.get(part.id);
      if (!mesh) continue;
      const isVisible = state.visibleLayers.has(part.layerID);
      const isSelected = state.selectedPartID === part.id;

      mesh.visible = isVisible || state.ghostHiddenLayers;
      const edges = this.edgeMeshes.get(part.id);
      // A ghosted layer keeps its faint solid but drops its edges, so it cannot be
      // mistaken for a layer that is switched on.
      if (edges) edges.visible = state.showEdges && isVisible;

      const material = mesh.material;
      material.emissive.setHex(isSelected ? 0x1a6bd9 : 0x000000);
      material.emissiveIntensity = isSelected ? 0.55 : 0;
      material.transparent = !isVisible && !isSelected;
      material.opacity = isVisible || isSelected ? 1 : 0.12;
      material.depthWrite = !material.transparent;
      material.needsUpdate = true;

      // Pull each layer away from the element's middle along the build-up normal.
      const offset = [0, 0, 0];
      if (state.explode > 0) {
        const partCentreN = (part.frameSpan.n[0] + part.frameSpan.n[1]) / 2;
        const shift = ((partCentreN - centreN) / thickness) * spread * state.explode * 2;
        offset[0] = frame.normal[0] * shift;
        offset[1] = frame.normal[1] * shift;
        offset[2] = frame.normal[2] * shift;
      }
      const position = new THREE.Vector3(
        part.origin[0] + offset[0],
        part.origin[1] + offset[1],
        part.origin[2] + offset[2],
      );
      mesh.matrix.setPosition(position);
      mesh.matrixWorldNeedsUpdate = true;
      if (edges) {
        edges.matrix.setPosition(position);
        edges.matrixWorldNeedsUpdate = true;
      }
    }

    this.updateDimensions(state);
    this.requestRender();
  }

  /**
   * The chains describe the assembled element, so they are rebuilt only when the set of
   * visible layers changes — not on every selection or slider move.
   */
  updateDimensions(state) {
    if (!state.showDimensions) {
      if (this.dimensionGroup) this.dimensionGroup.visible = false;
      return;
    }
    const key = [...state.visibleLayers].sort().join(',');
    if (key !== this.dimensionKey || !this.dimensionGroup) {
      this.removeDimensions();
      this.dimensionGroup = buildDimensionOverlay(this.doc, state.visibleLayers);
      this.centering.add(this.dimensionGroup);
      this.dimensionKey = key;
    }
    this.dimensionGroup.visible = true;
  }

  removeDimensions() {
    if (!this.dimensionGroup) return;
    this.centering.remove(this.dimensionGroup);
    disposeOverlay(this.dimensionGroup);
    this.dimensionGroup = null;
    this.dimensionKey = null;
  }

  // MARK: - Camera

  /** What the camera should frame: the parts plus the dimension drawing when it is on. */
  framingObjects() {
    const objects = [...this.partMeshes.values()].filter((mesh) => mesh.visible);
    if (this.dimensionGroup && this.dimensionGroup.visible) objects.push(this.dimensionGroup);
    return objects.length ? objects : [...this.partMeshes.values()];
  }

  /**
   * Aim the camera along the preset direction and fit the visible content.
   *
   * Flat presets swap to the orthographic camera, so the drawing reads as a true
   * elevation — parallel edges stay parallel and nothing recedes.
   */
  moveTo(presetKey) {
    if (!this.doc) return;
    const preset = VIEW_PRESETS[presetKey] || VIEW_PRESETS.iso;
    const { direction, up } = presetVectors(preset, this.doc.frame);
    const flat = Boolean(preset.flat);
    this.useCamera(flat ? this.orthographicCamera : this.perspectiveCamera, flat);

    // Bounding boxes are read from world matrices, so make sure they are current.
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const object of this.framingObjects()) box.expandByObject(object);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.25);
    const camera = this.camera;

    camera.up.copy(up);
    this.controls.target.copy(sphere.center);

    if (flat) {
      // With a parallel projection the distance does not change the size on screen,
      // only what stays between the near and far planes — so simply stand well clear.
      const distance = radius * 4;
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      camera.lookAt(sphere.center);
      camera.near = 0.01;
      camera.far = distance + radius * 2;
      camera.zoom = 1;
      camera.updateMatrixWorld(true);
      this.orthoFit = this.flatFit(box, camera);
      this.applyOrthoFrustum(this.aspect);
    } else {
      const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
      const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
      const distance = (radius / Math.max(Math.sin(Math.min(halfV, halfH)), 0.05)) * 1.12;
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      camera.lookAt(sphere.center);
    }

    this.controls.update();
    this.requestRender();
  }

  /**
   * The content's exact extent in camera space. A bounding sphere would waste most of
   * the viewport on a flat view, because a wall's diagonal is far longer than its height.
   */
  flatFit(box, camera) {
    const inverse = new THREE.Matrix4().copy(camera.matrixWorld).invert();
    const corner = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < 8; i += 1) {
      corner
        .set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
        .applyMatrix4(inverse);
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y);
      maxY = Math.max(maxY, corner.y);
    }

    const margin = 1.06;
    return {
      centreX: (minX + maxX) / 2,
      centreY: (minY + maxY) / 2,
      halfWidth: Math.max(((maxX - minX) / 2) * margin, 0.05),
      halfHeight: Math.max(((maxY - minY) / 2) * margin, 0.05),
    };
  }

  /** Grows the fitted extent to the viewport's aspect so nothing is ever clipped. */
  applyOrthoFrustum(aspect) {
    const fit = this.orthoFit;
    if (!fit) return;
    const halfHeight = Math.max(fit.halfHeight, fit.halfWidth / aspect);
    const halfWidth = halfHeight * aspect;
    const camera = this.orthographicCamera;
    camera.left = fit.centreX - halfWidth;
    camera.right = fit.centreX + halfWidth;
    camera.top = fit.centreY + halfHeight;
    camera.bottom = fit.centreY - halfHeight;
    camera.updateProjectionMatrix();
  }

  // MARK: - Picking

  /** The part behind a pointer position, or null when the user clicked empty space. */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const candidates = [...this.partMeshes.values()].filter((mesh) => mesh.visible);
    const hits = this.raycaster.intersectObjects(candidates, false);
    return hits.length ? hits[0].object.userData.partID : null;
  }
}
