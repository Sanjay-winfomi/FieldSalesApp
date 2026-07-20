import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ScrollView, RefreshControl } from 'react-native';
import { Home, Store, Clock, User, Check, LogOut } from 'lucide-react-native';
import DealerDirectoryScreen from './DealerDirectoryScreen';

export default function HomeScreen({ 
  employee,
  dayStatus = 'not_checked_in', // 'not_checked_in' | 'checked_in' | 'day_ended'
  visitsCount = 0,
  distanceTravelled = '0.0 km',
  attendance,
  visits = [],
  refreshing = false,
  onRefresh,
  onNavigateToDayCheckIn,
  onNavigateToDayCheckOut,
  onSelectDealer,
  onLogout
}) {
  const [activeTab, setActiveTab] = useState('home');

  const formatTime = (isoString) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const checkInTime = attendance?.check_in_time ? formatTime(attendance.check_in_time) : '';

  const renderHeader = () => (
    <View style={styles.header}>
      <View>
        <Text style={styles.greeting}>Good morning</Text>
        <Text style={styles.userName}>{employee?.name || 'User'}</Text>
      </View>
    </View>
  );

  const renderHomeContent = () => (
    <ScrollView 
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Day Status Card */}
      {dayStatus === 'not_checked_in' && (
        <TouchableOpacity 
          style={[styles.statusCard, styles.statusCardNotCheckedIn]}
          onPress={onNavigateToDayCheckIn}
        >
          <View style={styles.statusLeft}>
            <Text style={styles.statusLabel}>Day status</Text>
            <Text style={styles.statusValue}>Not checked in</Text>
          </View>
          <View style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>Check in</Text>
          </View>
        </TouchableOpacity>
      )}

      {dayStatus === 'checked_in' && (
        <View style={[styles.statusCard, styles.statusCardCheckedIn]}>
          <View style={styles.statusLeft}>
            <Text style={styles.statusLabel}>Day status</Text>
            <Text style={styles.statusValueCheckedIn}>Checked in {checkInTime}</Text>
          </View>
          <View style={styles.checkIconContainer}>
            <Check size={18} color="#1E6B4B" />
          </View>
        </View>
      )}

      {dayStatus === 'day_ended' && (
        <View style={[styles.statusCard, styles.statusCardDayEnded]}>
          <View style={styles.statusLeft}>
            <Text style={styles.statusLabel}>Day status</Text>
            <Text style={styles.statusValueDayEnded}>Day ended</Text>
          </View>
          <View style={styles.dayEndedPill}>
            <Text style={styles.dayEndedPillText}>Completed</Text>
          </View>
        </View>
      )}

      {/* Active Dealer Visit Card */}
      {(() => {
        const activeVisit = visits.find(v => !v.check_out_time);
        if (!activeVisit) return null;
        return (
          <View style={[styles.statusCard, styles.statusCardActiveVisit]}>
            <View style={styles.statusLeft}>
              <Text style={styles.statusLabel}>Active visit</Text>
              <Text style={styles.statusValueActiveVisit}>
                At {activeVisit.dealer_name || `Dealer #${activeVisit.dealer_id}`}
              </Text>
            </View>
            <TouchableOpacity 
              style={styles.actionBtnCheckOut}
              onPress={() => {
                const dl = { id: activeVisit.dealer_id, name: activeVisit.dealer_name };
                onSelectDealer(dl, true);
              }}
            >
              <Text style={styles.actionBtnText}>Check out</Text>
            </TouchableOpacity>
          </View>
        );
      })()}

      {/* Stats Cards Row */}
      <View style={styles.statsRow}>
        <View style={[styles.statCard, styles.statCardBlue]}>
          <Text style={[styles.statNumber, styles.textBlue]}>{visitsCount}</Text>
          <Text style={styles.statLabel}>visits today</Text>
        </View>

        <View style={[styles.statCard, styles.statCardAmber]}>
          <Text style={[styles.statNumber, styles.textAmber]}>{distanceTravelled}</Text>
          <Text style={styles.statLabel}>travelled</Text>
        </View>
      </View>

      {dayStatus === 'checked_in' && (
        <TouchableOpacity 
          style={styles.outlineButton}
          onPress={onNavigateToDayCheckOut}
        >
          <Text style={styles.outlineButtonText}>Proceed to day check-out</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );

  const renderHistoryContent = () => (
    <ScrollView 
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Text style={styles.tabHeading}>Visit history</Text>
      <View style={styles.historyList}>
        {visits.length === 0 ? (
          <Text style={styles.emptyText}>No visits recorded yet today.</Text>
        ) : (
          [...visits].reverse().map((visit) => (
            <View key={visit.id} style={styles.historyCard}>
              <View style={styles.historyHeader}>
                <Text style={styles.historyDealer}>{visit.dealer_name || `Dealer #${visit.dealer_id}`}</Text>
                <Text style={styles.historyTime}>{formatTime(visit.check_in_time)}</Text>
              </View>
              <Text style={styles.historyDetails}>
                {visit.check_out_time 
                  ? `Checked out after ${visit.visit_duration_minutes || 0} min`
                  : 'Currently checked in'
                }
              </Text>
              {visit.justification_note && (
                <Text style={styles.justificationNote}>
                  Note: {visit.justification_note}
                </Text>
              )}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );

  const renderProfileContent = () => (
    <ScrollView 
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Text style={styles.tabHeading}>Your profile</Text>
      <View style={styles.profileCard}>
        <Text style={styles.profileName}>{employee?.name || 'User'}</Text>
        <Text style={styles.profileRole}>{employee?.role === 'manager' ? 'Manager' : 'Field sales representative'}</Text>
        <Text style={styles.profileDetail}>Username: {employee?.username}</Text>
        <Text style={styles.profileDetail}>Region: {employee?.region}</Text>
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={onLogout}>
        <LogOut size={16} color="#D8534A" style={styles.logoutIcon} />
        <Text style={styles.logoutText}>Log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  const renderBody = () => {
    switch (activeTab) {
      case 'home': return renderHomeContent();
      case 'dealers': return <DealerDirectoryScreen onSelectDealer={onSelectDealer} />;
      case 'history': return renderHistoryContent();
      case 'profile': return renderProfileContent();
      default: return renderHomeContent();
    }
  };

  return (
    <View style={styles.container}>
      {renderHeader()}
      <View style={styles.body}>{renderBody()}</View>
      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('home')}>
          <Home size={22} color={activeTab === 'home' ? '#0082D1' : '#8A8A8A'} />
          <Text style={[styles.tabLabel, activeTab === 'home' && styles.tabLabelActive]}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('dealers')}>
          <Store size={22} color={activeTab === 'dealers' ? '#0082D1' : '#8A8A8A'} />
          <Text style={[styles.tabLabel, activeTab === 'dealers' && styles.tabLabelActive]}>Dealers</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('history')}>
          <Clock size={22} color={activeTab === 'history' ? '#0082D1' : '#8A8A8A'} />
          <Text style={[styles.tabLabel, activeTab === 'history' && styles.tabLabelActive]}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('profile')}>
          <User size={22} color={activeTab === 'profile' ? '#0082D1' : '#8A8A8A'} />
          <Text style={[styles.tabLabel, activeTab === 'profile' && styles.tabLabelActive]}>Profile</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAFA' },
  header: { backgroundColor: '#FFFFFF', paddingHorizontal: 20, paddingTop: 48, paddingBottom: 16, borderBottomWidth: 0.5, borderColor: '#E0E0E0' },
  greeting: { fontSize: 12, color: '#8A8A8A' },
  userName: { fontSize: 18, fontWeight: '500', color: '#434343', marginTop: 2 },
  body: { flex: 1 },
  scrollContent: { padding: 20 },
  tabHeading: { fontSize: 20, fontWeight: '500', color: '#434343', marginBottom: 16 },
  statusCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, borderWidth: 0.5, borderColor: '#E0E0E0' },
  statusCardNotCheckedIn: { borderLeftWidth: 4, borderLeftColor: '#8A8A8A' },
  statusCardCheckedIn: { borderLeftWidth: 4, borderLeftColor: '#4FD29F', backgroundColor: '#F4FBF8', borderColor: '#D4F3E6' },
  statusCardDayEnded: { borderLeftWidth: 4, borderLeftColor: '#E9C03C', backgroundColor: '#FDF3E0', borderColor: '#FBEAD0' },
  statusCardActiveVisit: { borderLeftWidth: 4, borderLeftColor: '#0082D1', backgroundColor: '#F2F9FD', borderColor: '#D0E3F0' },
  statusLeft: { flex: 1 },
  statusLabel: { fontSize: 12, color: '#8A8A8A', marginBottom: 4 },
  statusValue: { fontSize: 16, fontWeight: '500', color: '#434343' },
  statusValueCheckedIn: { fontSize: 16, fontWeight: '500', color: '#1E6B4B' },
  statusValueDayEnded: { fontSize: 16, fontWeight: '500', color: '#8E6C0C' },
  statusValueActiveVisit: { fontSize: 16, fontWeight: '500', color: '#0082D1' },
  actionBtn: { backgroundColor: '#0082D1', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  actionBtnCheckOut: { backgroundColor: '#D8534A', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  actionBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '500' },
  checkIconContainer: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 0.5, borderColor: '#4FD29F', justifyContent: 'center', alignItems: 'center' },
  dayEndedPill: { backgroundColor: '#FDF3E0', borderWidth: 0.5, borderColor: '#E9C03C', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  dayEndedPillText: { fontSize: 11, fontWeight: '500', color: '#8E6C0C' },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  statCard: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', padding: 16, alignItems: 'center' },
  statCardBlue: { backgroundColor: '#F2F9FD', borderColor: '#D0E3F0', marginRight: 10 },
  statCardAmber: { backgroundColor: '#FDF3E0', borderColor: '#FBEAD0', marginLeft: 10 },
  statNumber: { fontSize: 22, fontWeight: '500', marginBottom: 4 },
  textBlue: { color: '#0082D1' },
  textAmber: { color: '#8E6C0C' },
  statLabel: { fontSize: 12, color: '#8A8A8A', textAlign: 'center' },
  outlineButton: { borderWidth: 0.5, borderColor: '#0082D1', borderRadius: 8, height: 44, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  outlineButtonText: { color: '#0082D1', fontSize: 14, fontWeight: '500' },
  tabBar: { flexDirection: 'row', backgroundColor: '#FFFFFF', borderTopWidth: 0.5, borderColor: '#E0E0E0', height: 56, paddingBottom: 6 },
  tabItem: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 6 },
  tabLabel: { fontSize: 10, color: '#8A8A8A', marginTop: 3 },
  tabLabelActive: { color: '#0082D1', fontWeight: '500' },
  historyList: { marginTop: 8 },
  historyCard: { backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', padding: 16, marginBottom: 12 },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  historyDealer: { fontSize: 14, fontWeight: '500', color: '#434343' },
  historyTime: { fontSize: 12, color: '#8A8A8A' },
  historyDetails: { fontSize: 12, color: '#8A8A8A' },
  justificationNote: { fontSize: 12, color: '#D8534A', marginTop: 4, fontStyle: 'italic' },
  profileCard: { backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', padding: 16, marginBottom: 20 },
  profileName: { fontSize: 16, fontWeight: '500', color: '#434343', marginBottom: 2 },
  profileRole: { fontSize: 13, color: '#8A8A8A', marginBottom: 12 },
  profileDetail: { fontSize: 12, color: '#8A8A8A', marginBottom: 6 },
  logoutButton: { flexDirection: 'row', height: 44, borderWidth: 0.5, borderColor: '#D8534A', backgroundColor: '#FBEAE9', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  logoutIcon: { marginRight: 8 },
  logoutText: { color: '#D8534A', fontSize: 14, fontWeight: '500' },
  emptyText: { color: '#8A8A8A', textAlign: 'center', marginTop: 20, fontSize: 14 }
});
