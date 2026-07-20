import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export default function SplashScreen() {
  return (
    <View style={styles.container}>
      {/* 2x2 Grid Logo Mark */}
      <View style={styles.logoMark}>
        <View style={styles.logoRow}>
          <View style={[styles.logoBlock, { backgroundColor: '#4FD29F' }]} />
          <View style={[styles.logoBlock, { backgroundColor: '#E9C03C' }]} />
        </View>
        <View style={styles.logoRow}>
          <View style={[styles.logoBlock, { backgroundColor: '#0082D1' }]} />
          <View style={[styles.logoBlock, { backgroundColor: '#434343' }]} />
        </View>
      </View>

      <Text style={styles.title}>fieldtrack</Text>
      <Text style={styles.tagline}>attendance and dealer visit tracking</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAFAFA',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  logoMark: {
    width: 64,
    height: 64,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 20,
  },
  logoRow: {
    flexDirection: 'row',
    flex: 1,
  },
  logoBlock: {
    flex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '500',
    color: '#434343',
    marginBottom: 8,
  },
  tagline: {
    fontSize: 14,
    color: '#8A8A8A',
    textAlign: 'center',
  },
});
