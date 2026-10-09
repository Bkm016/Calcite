import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, parseMojang, parseTiny, parseTsrg } from '../dist/names.js';

const MOJANG = [
  '# comment',
  'net.minecraft.client.Minecraft -> fgo:',
  '    net.minecraft.client.player.LocalPlayer player -> a',
  '    int fps -> b',
  '    java.lang.String fps -> c',
  '    12:15:void tick() -> d',
  '    20:22:void attack(net.minecraft.world.entity.Entity,int[]):33:35 -> a',
  '    40:41:void <init>() -> <init>',
  '    50:51:java.lang.String toString() -> toString',
  '    60:61:void unmapped() -> e',
  'net.minecraft.client.player.LocalPlayer -> fzz:',
  'net.minecraft.world.entity.Entity -> bsr:',
  'com.mojang.Library -> com.mojang.Library:',
  '    void open() -> open',
  '',
].join('\n');

test('Mojang mappings compose with intermediary (tiny v1 and v2)', () => {
  const v1 = [
    'v1\tofficial\tintermediary',
    'CLASS\tfgo\tnet/minecraft/class_310',
    'CLASS\tfzz\tnet/minecraft/class_746',
    'CLASS\tbsr\tnet/minecraft/class_1297',
    'FIELD\tfgo\tLfzz;\ta\tfield_1724',
    'FIELD\tfgo\tI\tb\tfield_1',
    'FIELD\tfgo\tLjava/lang/String;\tc\tfield_2',
    'METHOD\tfgo\t()V\td\tmethod_1574',
    'METHOD\tfgo\t(Lbsr;[I)V\ta\tmethod_9',
  ].join('\n');
  const v2 = [
    'tiny\t2\t0\tofficial\tintermediary',
    'c\tfgo\tnet/minecraft/class_310',
    '\tf\tLfzz;\ta\tfield_1724',
    '\tf\tI\tb\tfield_1',
    '\tf\tLjava/lang/String;\tc\tfield_2',
    '\tm\t()V\td\tmethod_1574',
    '\t\tp\t1\t\tignored',
    '\tm\t(Lbsr;[I)V\ta\tmethod_9',
    'c\tfzz\tnet/minecraft/class_746',
    'c\tbsr\tnet/minecraft/class_1297',
  ].join('\n');
  for (const tiny of [v1, v2]) {
    const target = parseTiny(tiny);
    const out = compose(
      parseMojang(MOJANG),
      target,
      (c) => target.classes.get(c.obf.replace(/\./g, '/'))?.replace(/\//g, '.') ?? (c.obf === c.named ? c.named : undefined),
    );
    assert.equal(
      out,
      [
        'net.minecraft.client.Minecraft -> net.minecraft.class_310:',
        '    net.minecraft.client.player.LocalPlayer player -> field_1724',
        '    int fps -> field_1',
        '    java.lang.String fps -> field_2',
        '    void tick() -> method_1574',
        '    void attack(net.minecraft.world.entity.Entity,int[]) -> method_9',
        '    java.lang.String toString() -> toString',
        'net.minecraft.client.player.LocalPlayer -> net.minecraft.class_746:',
        'net.minecraft.world.entity.Entity -> net.minecraft.class_1297:',
        'com.mojang.Library -> com.mojang.Library:',
        '    void open() -> open',
        '',
      ].join('\n'),
    );
  }
});

test('Mojang mappings compose with SRG (tsrg2)', () => {
  const tsrg = [
    'tsrg2 obf srg id',
    'fgo net/minecraft/src/C_1_ 1',
    '\ta f_91074_ 2',
    '\td ()V m_91398_ 3',
    '\t\t0 o p_0_ 4',
    '\tstatic',
    'fzz net/minecraft/src/C_2_ 5',
  ].join('\n');
  const out = compose(parseMojang(MOJANG), parseTsrg(tsrg), (c) => c.named);
  assert.match(
    out,
    /^net\.minecraft\.client\.Minecraft -> net\.minecraft\.client\.Minecraft:\n {4}net\.minecraft\.client\.player\.LocalPlayer player -> f_91074_\n {4}void tick\(\) -> m_91398_\n/,
  );
});
