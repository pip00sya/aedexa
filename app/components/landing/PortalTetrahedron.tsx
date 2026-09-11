"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/** Тетраэдр, у которого каждая грань — окно в свою сцену */

/** Сторона текстуры окна */
const PORTAL_SIZE = 768;

/** Палитра сцен */
const INK = 0xf2f2f2;
const PALE = 0xededed;
const LIGHT = 0xd6d6d6;
const MID = 0xb0b0b0;

/** Глубина зала */
const SKY = 0x101014;
/** Пол: на тон светлее неба, иначе горизонт не читается */
const FLOOR = 0x1b1b21;

/** Общая оптика всех четырех окон */
const HORIZON = { eye: 1.7, back: 7.4, vanishing: -14, fov: 44 };

/** Насколько точка съемки внутри окна ведет за положением зрителя */
const PARALLAX = 1.2;

/** Длина круга движения, секунды */
const LOOP = 26;
const SPIN = (Math.PI * 2) / LOOP;

/** Насколько кадр внутри окна крупнее самого холста */
const VIEW_ZOOM = 0.82;

/** Оси грани в системе знака */
type Facet = {
  right: THREE.Vector3;
  up: THREE.Vector3;
  center: THREE.Vector3;
};

type Portal = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  target: THREE.WebGLRenderTarget;
  /** Куда смотрит окно на этом кадре */
  animate: (lean: THREE.Vector2) => void;
};

function supportsWebGl() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

// Материалы

/** Камень: матовый, с чуть заметной поволокой - так он не выглядит картоном */
function stone(color: number) {
  return new THREE.MeshPhongMaterial({ color, specular: 0x121212, shininess: 6 });
}

function hairline(opacity: number) {
  return new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity });
}

/** Объем с ребрами */
function block(geometry: THREE.BufferGeometry, color: number, edgeOpacity = 0.34): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, stone(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), hairline(edgeOpacity)));
  return group;
}

// Общий зал

/** Пол - он один на все четыре окна */
function hall(): THREE.Group {
  const group = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(56, 84), stone(FLOOR));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -20;
  floor.receiveShadow = true;
  group.add(floor);

  const joints: number[] = [];
  for (let x = -14; x <= 14; x += 2.4) joints.push(x, 0.012, 10, x, 0.012, -46);
  for (let z = 10; z >= -46; z -= 2.4) joints.push(-14, 0.012, z, 14, 0.012, z);

  const seams = new THREE.BufferGeometry();
  seams.setAttribute("position", new THREE.Float32BufferAttribute(joints, 3));
  group.add(new THREE.LineSegments(seams, hairline(0.09)));

  return group;
}

/** Колонна ордера */
function column(height: number, thickness: number, tone = PALE): THREE.Group {
  const group = new THREE.Group();

  const base = block(new THREE.BoxGeometry(thickness * 2.7, thickness * 0.8, thickness * 2.7), MID);
  base.position.y = thickness * 0.4;
  group.add(base);

  const shaft = block(
    new THREE.CylinderGeometry(thickness * 0.86, thickness, height, 18),
    tone,
    0.16,
  );
  shaft.position.y = thickness * 0.8 + height / 2;
  group.add(shaft);

  const capital = block(
    new THREE.BoxGeometry(thickness * 2.5, thickness * 0.9, thickness * 2.5),
    LIGHT,
  );
  capital.position.y = thickness * 0.8 + height + thickness * 0.45;
  group.add(capital);

  return group;
}

// Четыре сцены

/** Сцена первая */
function buildNave(): THREE.Group {
  const group = new THREE.Group();
  group.add(hall());

  const bays = 14;
  const step = 1.85;

  for (let bay = 0; bay < bays; bay += 1) {
    const z = 2.4 - bay * step;

    for (const x of [-2.1, 2.1]) {
      const pier = column(2.3, 0.22);
      pier.position.set(x, 0, z);
      group.add(pier);
    }

    const vault = block(new THREE.TorusGeometry(1.94, 0.17, 10, 30, Math.PI), bay ? LIGHT : PALE);
    vault.position.set(0, 2.72, z);
    group.add(vault);
  }

  // Антаблемент над рядом и карнизы по сторонам
  const architrave = block(new THREE.BoxGeometry(5.1, 0.32, bays * step), PALE);
  architrave.position.set(0, 4.76, 2.4 - (bays * step) / 2);
  group.add(architrave);

  for (const x of [-2.5, 2.5]) {
    const cornice = block(new THREE.BoxGeometry(0.34, 0.42, bays * step), LIGHT);
    cornice.position.set(x, 3.05, 2.4 - (bays * step) / 2);
    group.add(cornice);
  }

  return group;
}

/** Сцена вторая */
function buildViaduct(): THREE.Group {
  const group = new THREE.Group();
  group.add(hall());

  /** Пролет: устои, арка между ними и проезжая часть сверху */
  const tier = (bays: number, span: number, height: number, rise: number, tone: number) => {
    const arcade = new THREE.Group();
    const width = bays * span;

    for (let bay = 0; bay <= bays; bay += 1) {
      const x = -width / 2 + bay * span;

      const pier = block(new THREE.BoxGeometry(span * 0.32, height, 1.7), tone);
      pier.position.set(x, height / 2, 0);
      arcade.add(pier);

      if (bay === bays) continue;

      const arch = block(new THREE.TorusGeometry(span / 2, rise, 9, 24, Math.PI), tone);
      arch.position.set(x + span / 2, height, 0);
      arcade.add(arch);
    }

    const deck = block(new THREE.BoxGeometry(width + span * 0.4, 0.42, 2.1), PALE);
    deck.position.set(0, height + span / 2 + 0.21, 0);
    arcade.add(deck);

    return arcade;
  };

  // Ближний виадук
  const near = new THREE.Group();
  near.position.z = -9;
  near.add(tier(7, 4, 3.1, 0.24, LIGHT));

  const upper = tier(13, 2.15, 1.5, 0.16, PALE);
  upper.position.y = 5.4;
  near.add(upper);
  group.add(near);

  // Дальний - тот же самый, только вдали: по нему и меряется расстояние
  const far = new THREE.Group();
  far.position.set(2.5, 0, -27);
  far.add(tier(7, 4, 3.1, 0.24, MID));
  const farUpper = tier(13, 2.15, 1.5, 0.16, LIGHT);
  farUpper.position.y = 5.4;
  far.add(farUpper);
  group.add(far);

  return group;
}

/** Сцена третья */
function buildRotunda(): THREE.Group {
  const group = new THREE.Group();
  group.add(hall());

  const stage = new THREE.Group();
  stage.position.set(0, 0, -8.2);
  group.add(stage);

  // Стилобат: три ступени по кругу
  for (let step = 0; step < 3; step += 1) {
    const platform = block(
      new THREE.CylinderGeometry(4.1 - step * 0.34, 4.1 - step * 0.34, 0.22, 48),
      step === 2 ? LIGHT : MID,
      0.14,
    );
    platform.position.y = 0.11 + step * 0.22;
    stage.add(platform);
  }

  const podium = 0.66;
  const columns = 18;
  const ring = 3.2;

  for (let index = 0; index < columns; index += 1) {
    const angle = (index / columns) * Math.PI * 2;
    const shaft = column(3, 0.2);
    shaft.position.set(Math.sin(angle) * ring, podium, Math.cos(angle) * ring);
    stage.add(shaft);
  }

  // Кольцевой антаблемент поверх колоннады
  const entablature = block(new THREE.CylinderGeometry(3.62, 3.62, 0.46, 48, 1, true), PALE, 0.2);
  entablature.position.y = podium + 3.62;
  stage.add(entablature);

  // Купол: кольца убывающего радиуса - так его и клали
  for (let course = 0; course < 7; course += 1) {
    const radius = 3.4 * Math.cos(((course / 7) * Math.PI) / 2.5);
    const dome = block(
      new THREE.CylinderGeometry(radius * 0.9, radius, 0.3, 44),
      course % 2 ? LIGHT : PALE,
      0.12,
    );
    dome.position.y = podium + 3.9 + course * 0.3;
    stage.add(dome);
  }

  const lantern = block(new THREE.CylinderGeometry(0.34, 0.34, 0.66, 16), PALE);
  lantern.position.y = podium + 6.2;
  stage.add(lantern);

  return group;
}

/** Сцена четвертая */
function buildSpiralStair(): THREE.Group {
  const group = new THREE.Group();
  group.add(hall());

  const stage = new THREE.Group();
  stage.position.set(0, 0, -6.2);
  group.add(stage);

  const steps = 34;
  const rise = 0.2;
  const turn = Math.PI / 8;
  const inner = 0.36;
  const outer = 2.1;

  // Столб, вокруг которого все навито
  const newel = block(
    new THREE.CylinderGeometry(inner, inner * 1.15, steps * rise + 0.9, 24),
    LIGHT,
    0.14,
  );
  newel.position.y = (steps * rise + 0.9) / 2;
  stage.add(newel);

  const railing: THREE.Vector3[] = [];

  for (let step = 0; step < steps; step += 1) {
    const angle = step * turn;
    const y = step * rise + rise / 2;

    // Проступь: клин от столба наружу, повернутый на свой угол
    const tread = block(
      new THREE.BoxGeometry(outer - inner, rise * 0.62, 0.74),
      step % 4 === 0 ? PALE : LIGHT,
      0.22,
    );
    tread.position.set(
      Math.cos(angle) * (inner + (outer - inner) / 2),
      y,
      Math.sin(angle) * (inner + (outer - inner) / 2),
    );
    tread.rotation.y = -angle;
    stage.add(tread);

    // Балясина у наружного края и точка будущего поручня над ней
    const post = block(new THREE.BoxGeometry(0.07, 0.92, 0.07), MID, 0.2);
    post.position.set(Math.cos(angle) * outer, y + 0.46, Math.sin(angle) * outer);
    stage.add(post);

    railing.push(new THREE.Vector3(Math.cos(angle) * outer, y + 0.92, Math.sin(angle) * outer));
  }

  // Поручень: одна труба по спирали, без стыков - она и держит форму
  const rail = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railing), steps * 4, 0.055, 8, false),
    stone(PALE),
  );
  rail.castShadow = true;
  stage.add(rail);

  // Площадка наверху
  const top = block(new THREE.BoxGeometry(2.6, 0.24, 2.6), PALE, 0.24);
  top.position.set(Math.cos(steps * turn) * 1.5, steps * rise + 0.12, Math.sin(steps * turn) * 1.5);
  stage.add(top);

  // Стена с проемами позади
  const wall = new THREE.Group();
  wall.position.z = -8;
  stage.add(wall);

  for (let bay = -3; bay <= 3; bay += 1) {
    const pier = block(new THREE.BoxGeometry(1, 4.2, 1.1), bay % 2 ? LIGHT : PALE);
    pier.position.set(bay * 3.4, 2.1, 0);
    wall.add(pier);

    if (bay === 3) continue;

    const arch = block(new THREE.TorusGeometry(1.2, 0.2, 9, 22, Math.PI), LIGHT);
    arch.position.set(bay * 3.4 + 1.7, 4.2, 0);
    wall.add(arch);
  }

  const attic = block(new THREE.BoxGeometry(21.5, 0.5, 1.3), PALE);
  attic.position.set(0, 5.7, 0);
  wall.add(attic);

  return group;
}

const WORLDS = [buildNave, buildViaduct, buildRotunda, buildSpiralStair];

// Стекло окна

/** Грань - проем, а не наклейка */
const FACE_VERTEX = `
  attribute vec3 bary;
  varying vec3 vBary;

  void main() {
    vBary = bary;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FACE_FRAGMENT = `
  uniform sampler2D view;
  uniform vec2 resolution;
  uniform float zoom;
  uniform vec3 fade;
  varying vec3 vBary;

  void main() {
    vec2 uv = 0.5 + (gl_FragCoord.xy / resolution - 0.5) * zoom;

    // расстояние до ближайшего ребра, 0..1
    float edge = min(min(vBary.x, vBary.y), vBary.z) * 3.0;

    // мягкий переход у ребра, чтобы смена окна не бросалась в глаза
    float depth = pow(smoothstep(0.0, 0.58, edge), 0.9);

    // размытие по восьми точкам
    float radius = (1.0 - depth) * 0.022;
    vec2 slant = vec2(radius * 0.7);

    vec3 color = texture2D(view, uv).rgb * 0.28;
    color += texture2D(view, uv + vec2(radius, 0.0)).rgb * 0.12;
    color += texture2D(view, uv - vec2(radius, 0.0)).rgb * 0.12;
    color += texture2D(view, uv + vec2(0.0, radius)).rgb * 0.12;
    color += texture2D(view, uv - vec2(0.0, radius)).rgb * 0.12;
    color += texture2D(view, uv + slant).rgb * 0.06;
    color += texture2D(view, uv - slant).rgb * 0.06;
    color += texture2D(view, uv + vec2(slant.x, -slant.y)).rgb * 0.06;
    color += texture2D(view, uv - vec2(slant.x, -slant.y)).rgb * 0.06;

    // у ребра от сцены остается четверть
    gl_FragColor = vec4(mix(fade, color, 0.26 + 0.74 * depth), 1.0);
  }
`;

/** Четыре вершины тетраэдра и грани, собранные из них наружу */
const CORNERS = [
  [1, 1, 1],
  [-1, -1, 1],
  [-1, 1, -1],
  [1, -1, -1],
];
const FACES = [
  [2, 1, 0],
  [0, 3, 2],
  [1, 3, 0],
  [2, 3, 1],
];

type PortalTetrahedronProps = {
  /** Сторона холста в пикселях */
  size?: number;
  className?: string;
};

export default function PortalTetrahedron({ size = 520, className }: PortalTetrahedronProps) {
  const holder = useRef<HTMLDivElement>(null);
  // Поддержка WebGL выясняется до отрисовки
  const [broken, setBroken] = useState(() => typeof window !== "undefined" && !supportsWebGl());

  useEffect(() => {
    const mount = holder.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      console.error("WebGL недоступен", error);
      queueMicrotask(() => setBroken(true));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // четыре сцены, каждая в свою текстуру
    const portals: Portal[] = WORLDS.map((build) => {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(SKY);
      scene.fog = new THREE.FogExp2(SKY, 0.032);
      scene.add(build());

      // Свет косой и белый
      scene.add(new THREE.HemisphereLight(0xffffff, 0x14141a, 0.95));

      const sun = new THREE.DirectionalLight(0xffffff, 3.6);
      // Свет идет от зрителя и сверху-справа
      sun.position.set(7, 9, 9);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 52;
      sun.shadow.camera.left = -16;
      sun.shadow.camera.right = 16;
      sun.shadow.camera.top = 16;
      sun.shadow.camera.bottom = -16;
      scene.add(sun);

      // Подсветка с теневой стороны
      const fill = new THREE.DirectionalLight(0xffffff, 1.05);
      fill.position.set(-7, 3, 4);
      scene.add(fill);

      const camera = new THREE.PerspectiveCamera(HORIZON.fov, 1, 0.1, 90);
      camera.position.set(0, HORIZON.eye, HORIZON.back);
      camera.lookAt(0, HORIZON.eye, HORIZON.vanishing);

      const target = new THREE.WebGLRenderTarget(PORTAL_SIZE, PORTAL_SIZE, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        // Текстура окна хранится готовой к показу
        colorSpace: THREE.SRGBColorSpace,
      });

      return {
        scene,
        camera,
        target,
        animate: (lean: THREE.Vector2) => {
          // Сцена стоит на месте
          camera.position.set(
            lean.x * PARALLAX,
            HORIZON.eye + lean.y * PARALLAX * 0.55,
            HORIZON.back,
          );
          camera.lookAt(0, HORIZON.eye, HORIZON.vanishing);
        },
      };
    });

    // сам знак
    const scene = new THREE.Scene();

    const radius = 2.35;
    // Камера отодвинута ровно настолько, чтобы в кадр помещалась описанная сфера знака
    const view = THREE.MathUtils.degToRad(38) / 2;
    const distance = radius / Math.sin(view) + radius * 0.06;
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.2, distance);
    camera.lookAt(0, 0, 0);
    const corners = CORNERS.map(([x, y, z]) =>
      new THREE.Vector3(x, y, z).normalize().multiplyScalar(radius),
    );

    const knot = new THREE.Group();
    const facets: Facet[] = [];
    const materials: THREE.ShaderMaterial[] = [];

    FACES.forEach((face, index) => {
      const points = face.map((corner) => corners[corner]);
      const center = new THREE.Vector3()
        .addVectors(points[0], points[1])
        .add(points[2])
        .divideScalar(3);

      // Оси грани
      const normal = center.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0).projectOnPlane(normal).normalize();
      const right = new THREE.Vector3().crossVectors(up, normal).normalize();
      facets.push({ right, up, center });

      const position = new Float32Array(9);
      points.forEach((point, corner) => position.set([point.x, point.y, point.z], corner * 3));

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      // Барицентрические веса
      geometry.setAttribute(
        "bary",
        new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3),
      );

      const material = new THREE.ShaderMaterial({
        uniforms: {
          view: { value: portals[index].target.texture },
          resolution: { value: new THREE.Vector2(1, 1) },
          zoom: { value: VIEW_ZOOM },
          fade: { value: new THREE.Vector3(0x10 / 255, 0x10 / 255, 0x14 / 255) },
        },
        vertexShader: FACE_VERTEX,
        fragmentShader: FACE_FRAGMENT,
        side: THREE.DoubleSide,
      });
      materials.push(material);
      knot.add(new THREE.Mesh(geometry, material));
    });

    // Ребра - стержни, а не линии: толщину линии WebGL не дает, поэтому ребро набрано цилиндром
    const bars = new THREE.Group();
    const barMaterial = new THREE.MeshBasicMaterial({ color: 0x07070a });
    const barGeometry = new THREE.CylinderGeometry(0.034, 0.034, 1, 10);
    const jointGeometry = new THREE.SphereGeometry(0.046, 14, 10);
    const upAxis = new THREE.Vector3(0, 1, 0);

    for (let from = 0; from < corners.length; from += 1) {
      for (let to = from + 1; to < corners.length; to += 1) {
        const span = new THREE.Vector3().subVectors(corners[to], corners[from]);
        const bar = new THREE.Mesh(barGeometry, barMaterial);
        bar.position.copy(corners[from]).addScaledVector(span, 0.5);
        bar.scale.y = span.length();
        bar.quaternion.setFromUnitVectors(upAxis, span.clone().normalize());
        bars.add(bar);
      }

      const joint = new THREE.Mesh(jointGeometry, barMaterial);
      joint.position.copy(corners[from]);
      bars.add(joint);
    }
    knot.add(bars);
    scene.add(knot);

    // Шейдер считает по точкам буфера
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const material of materials) material.uniforms.resolution.value.copy(buffer);

    let frame = 0;
    const started = performance.now();

    const axis = new THREE.Vector3();
    const eye = new THREE.Vector3();
    const lean = new THREE.Vector2();

    const render = () => {
      const time = (performance.now() - started) / 1000;

      // Поворот считается до отрисовки окон
      knot.rotation.y = time * SPIN;
      knot.rotation.x = Math.sin(time * SPIN) * 0.26 + 0.14;
      knot.updateMatrixWorld(true);

      for (const [index, portal] of portals.entries()) {
        // Где стоит зритель относительно этого окна
        const facet = facets[index];
        eye
          .copy(camera.position)
          .sub(axis.copy(facet.center).applyQuaternion(knot.quaternion))
          .normalize();
        lean.set(
          eye.dot(axis.copy(facet.right).applyQuaternion(knot.quaternion)),
          eye.dot(axis.copy(facet.up).applyQuaternion(knot.quaternion)),
        );

        portal.animate(lean);
        renderer.setRenderTarget(portal.target);
        renderer.render(portal.scene, portal.camera);
      }
      renderer.setRenderTarget(null);

      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      for (const portal of portals) {
        portal.target.dispose();
        portal.scene.traverse((node) => {
          const line = node as THREE.Line;
          line.geometry?.dispose();
          const material = line.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material?.dispose();
        });
      }
      for (const material of materials) material.dispose();
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose();
      });
      barMaterial.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [size]);

  if (broken) {
    // Без WebGL знак остается знаком
    return (
      <div className={className} style={{ width: size, height: size }} aria-hidden="true">
        <svg viewBox="0 0 120 120" width={size} height={size} fill="none">
          <polygon points="60,17 12,99 58,73" fill="#c9c6bf" />
          <polygon points="62,73 108,99 60,17" fill="#f2efe8" />
          <polygon points="12,102 108,102 60,77" fill="#8e8b84" />
        </svg>
      </div>
    );
  }

  return <div ref={holder} className={className} aria-hidden="true" />;
}
